import './config/loadEnv.js';
import express from 'express';
import crypto from 'crypto';
import path from 'path';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import connectDB from './config/database.js';
import { fileURLToPath } from 'url';
import adminRoutes from './routes/admin.js';
import apiRoutes from './routes/api.js';
import revenueCatWebhook from './routes/revenuecat_webhook.js';
import mobileApiProxy from './routes/mobile-api-proxy.js';
import { mobileAppGuard } from './middleware/mobileAppGuard.js';
import tables_check from './helpers/create_tables.js';
import { checkEnvironment } from './helpers/checkEnvironment.js';
import connectAlchemyWS from './webhooks/alchemyWatcher.js';
import { connectBTCWatcher } from "./webhooks/btcWatcher.js";
import "./cronJobs.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Report missing configuration once, at boot, rather than as a per-request
// failure the operator only hears about from users. loadEnv.js is the first
// import, so .env has already been read by the time this runs.
checkEnvironment();

const app = express();

await connectDB();

await connectAlchemyWS();

await tables_check();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false // Disable CSP for development
}));

// CORS: only these browser origins may call the API from a web page. The mobile
// app sends no Origin header, and requests without one (app, server-to-server)
// are unaffected; this only stops arbitrary websites using a visitor's browser.
// It was cors() -- every origin allowed.
const CORS_ORIGINS = (process.env.CORS_ORIGINS ||
  'https://dashboard.bitplaypro.com,https://bitplaypro.com,https://www.bitplaypro.com')
  .split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || CORS_ORIGINS.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
}));

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

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Root route - redirect to admin login
app.get('/', (req, res) => {
  res.redirect('/admin/login');
});

// Routes
app.use('/admin', adminRoutes);
app.use('/webhooks/revenuecat', revenueCatWebhook);
app.use('/api', apiRoutes);

// Handle 404
app.use('*', (req, res) => {
  res.status(404).render('404', { title: 'Page Not Found' });
});

const PORT = process.env.PORT || process.env.ADMIN_PORT || 3001;

app.listen(PORT, () => {
  console.log(`Admin Panel running on port ${PORT}`);
  connectBTCWatcher().catch(err => console.error("BTC watcher fail:", err));
});

export default app;
