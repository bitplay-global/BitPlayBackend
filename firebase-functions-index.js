const functions = require('firebase-functions');
const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
const helmet = require('helmet');
const mongoose = require('mongoose');

// Import your routes (convert to CommonJS)
// const adminRoutes = require('./routes/admin-commonjs');
// const apiRoutes = require('./routes/api-commonjs');

const app = express();

// MongoDB connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB Connected');
  } catch (error) {
    console.error('MongoDB connection error:', error);
  }
};

connectDB();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false
}));

// CORS
app.use(cors({
  origin: true,
  credentials: true
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Production runs behind nginx on the same host. Trust only a loopback proxy, so
// a client cannot spoof X-Forwarded-For (which would defeat the login lockout),
// while req.secure / req.ip still reflect the real request.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.disable('x-powered-by');

// There is no fallback secret. A known default secret in the source let anyone
// who had read the source reason about session cookies. Without SESSION_SECRET a
// random per-process secret is used: admin sessions simply reset on restart.
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(48).toString('hex');
  console.error('[Session] SESSION_SECRET is not set: using a random per-process secret, so admin sessions reset on restart.');
}

// Session middleware
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: 'auto',      // Secure whenever the request arrived over HTTPS
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Basic route for testing
app.get('/', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Bitcoin Mining Backend API is running on Firebase Functions',
    timestamp: new Date().toISOString()
  });
});

// Routes (you'll need to convert your ES6 modules to CommonJS)
// app.use('/admin', adminRoutes);
// app.use('/api', apiRoutes);

// Handle 404
app.use('*', (req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Route not found' 
  });
});

// Export the Express app as a Firebase Function
exports.api = functions.https.onRequest(app);
