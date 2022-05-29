const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const app = express();
const port = process.env.PORT || 5000;

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json());

//doctor_admin
const uri = `mongodb://hdd_admin:${process.env.DB_PASS}@ac-0c57z8f-shard-00-00.uossnks.mongodb.net:27017,ac-0c57z8f-shard-00-01.uossnks.mongodb.net:27017,ac-0c57z8f-shard-00-02.uossnks.mongodb.net:27017/?ssl=true&replicaSet=atlas-7q1km5-shard-0&authSource=admin&retryWrites=true&w=majority`;

// console.log(uri);
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });


//middle tier function for jwt token
function verifyJWT(req, res, next) {

    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send({ message: 'UnAuthorized access' });
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'Forbidden access' });
        }
        req.decoded = decoded;
        next();
    });
}

async function run() {
    try {
        await client.connect();
        // console.log('Database connected');
        const servicesCollection = client.db('doctors_portal').collection('services');
        const bookingCollection = client.db('doctors_portal').collection('bookings');
        const userCollection = client.db('doctors_portal').collection('users');
        const doctorCollection = client.db('doctors_portal').collection('doctors');
        const paymentCollection = client.db('doctors_portal').collection('payments');
        const productCOllection = client.db('hdd_bd').collection('products');


        //check if a user is admin or not
        const verifyAdmin = async (req, res, next) => {
            const requester = req.decoded.email;
            const requesterAccount = await userCollection.findOne({ email: requester });
            if (requesterAccount.role === 'admin') {
                next();
            }
            else {
                res.status(403).send({ message: 'forbidden' });
            }
        }

        //handel and update social users
        app.put('/user/:email', async (req, res) => {
            const email = req.params.email;
            const user = req.body;
            const filter = { email: email };
            const options = { upsert: true };
            const updateDoc = {
                $set: user,
            };
            const result = await userCollection.updateOne(filter, updateDoc, options);
            const token = jwt.sign({ email: email }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' })
            res.send({ result, token });
        });

        //get all users
        app.get('/users', verifyJWT, async (req, res) => {
            const users = await userCollection.find().toArray();
            res.send(users);
        });

        //make user admin
        //handel and update social users
        app.put('/user/admin/:email', verifyJWT, verifyAdmin, async (req, res) => {
            const email = req.params.email;
            const filter = { email: email };
            const updateDoc = {
                $set: { role: 'admin' },
            };
            const result = await userCollection.updateOne(filter, updateDoc);
            res.send(result);
        });


        //check if a user admin or not
        app.get('/admin/:email', async (req, res) => {

            const email = req.params.email;
            const user = await userCollection.findOne({ email: email });
            const isAdmin = user?.role === 'admin';
            res.send({ admin: isAdmin })

        });



        app.get('/service', async (req, res) => {
            const query = {};
            const cursor = servicesCollection.find(query).project({ name: 1 });
            const services = await cursor.toArray();
            res.send(services);
        });

        app.get('/available', async (req, res) => {
            const date = req.query.date;

            //step 1: get all services
            const services = await servicesCollection.find().toArray();

            //step 2: get the booking of that day
            const query = { date: date };
            const bookings = await bookingCollection.find(query).toArray();

            //step 3: for each service, find bookings for that services
            services.forEach(service => {
                // step 4: find bookings for that service. output: [{}, {}, {}, {}]
                const serviceBookings = bookings.filter(book => book.treatment === service.name);
                // step 5: select slots for the service Bookings: ['', '', '', '']
                const bookedSlots = serviceBookings.map(book => book.slot);
                // step 6: select those slots that are not in bookedSlots
                const available = service.slots.filter(slot => !bookedSlots.includes(slot));
                //step 7: set available to slots to make it easier 
                service.slots = available;

                // service.booked = booked;
                // service.booked = serviceBooking.map(s => s.slot);
            });


            res.send(services);
        })

        app.get('/booking', verifyJWT, async (req, res) => {
            const patient = req.query.patient;
            // const authorization = req.headers.authorization;
            const decodedEmail = req.decoded.email;
            if (patient === decodedEmail) {
                // console.log('auth header', authorization);
                const query = { patient: patient };
                const bookings = await bookingCollection.find(query).toArray();
                return res.send(bookings);
            } else {
                return res.status(403).send({ message: 'Forbidden access' });
            }

        })

        //get a particular booking
        app.get('/booking/:id', verifyJWT, async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const booking = await bookingCollection.findOne(query);
            res.send(booking);
        })

        //add new element in booking
        app.post('/booking', async (req, res) => {
            const booking = req.body;
            const query = { treatment: booking.treatment, date: booking.date, patient: booking.patient };
            const exists = await bookingCollection.findOne(query);

            if (exists) {
                return res.send({ success: false, booking: exists })
            }

            const result = await bookingCollection.insertOne(booking);
            return res.send({ success: true, result });
        })

        //update a specific booking
        app.patch('/booking/:id', verifyJWT, async (req, res) => {
            const id = req.params.id;
            const payment = req.body;
            const filter = { _id: ObjectId(id) };
            const updatedDoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId
                }
            }

            const result = await paymentCollection.insertOne(payment);
            const updatedBooking = await bookingCollection.updateOne(filter, updatedDoc);
            res.send(updatedBooking);
        })


        //add doctor in the doctors collection by verified token and admin
        app.post('/doctor', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            const result = await doctorCollection.insertOne(doctor);
            res.send(result);
        });

        //show all the doctors
        app.get('/doctor', verifyJWT, verifyAdmin, async (req, res) => {
            const doctors = await doctorCollection.find().toArray();
            res.send(doctors);
        });

        //delete a doctor
        app.delete('/doctor/:email', verifyJWT, verifyAdmin, async (req, res) => {
            const email = req.params.email;
            const filter = { email: email };
            const result = await doctorCollection.deleteOne(filter);
            res.send(result);
        })


        //payment
        app.post('/create-payment-intent', verifyJWT, async (req, res) => {
            const service = req.body;
            const price = service.price;
            const amount = price * 100;
            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: 'usd',
                payment_method_types: ['card']
            });
            res.send({ clientSecret: paymentIntent.client_secret })
        });






        // .....................product...................
        app.get('/product', async (req, res) => {
            const query = {};
            const cursor = productCOllection.find(query);
            const products = await cursor.toArray();
            res.send(products);
        });

        app.get('/product/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const product = await productCOllection.findOne(query);
            res.send(product);
        });


        //POST: add new product
        app.post('/product', async (req, res) => {

            const newProduct = req.body;
            const result = await productCOllection.insertOne(newProduct);
            res.send(result);
        });

        //update product quantity
        app.put('/product/:id', async (req, res) => {
            const id = req.params.id;
            const updatedProduct = req.body;
            const filter = { _id: ObjectId(id) };
            const options = { upsert: true };
            const updatedDoc = {
                $set: {
                    available_quantity: updatedProduct.available_quantity,
                }
            };
            const result = await productCOllection.updateOne(filter, updatedDoc, options);
            res.send(result);
        });

        //delete single item item api
        app.delete('/product/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const result = await productCOllection.deleteOne(query);
            res.send(result);
        });

        /** 
         * APi naming convention
         * app.get('/booking') //get all booking in this collection or get more than one or by filter query
         * app.get('/booking/:id') // get a specific booking
         * app.post('/booking') // add a new booking
         * app.post('/booking/:id') //update a single booking
         * app.put('/booking/:id') //update(if exist) or insert(upsert) a single booking
         * app.delete('/booking/:id') // delete one booking.
        */



    }
    finally {

    }
}

run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('Hello from hdd server')
})

app.listen(port, () => {
    console.log(`HDD app listening on port ${port}`)
})