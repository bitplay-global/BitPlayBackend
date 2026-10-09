/**
 * Admin sessions survive a restart (MongoDB session store), expire, are
 * removed on logout, and the post-login redirect only goes inside the panel.
 * Run: node tests/admin-session.test.mjs
 */
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import mongoose from 'mongoose';
import ejs from 'ejs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoSessionStore } from '../helpers/mongoSessionStore.js';
import { safeAdminNext } from '../helpers/adminRedirect.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('post-login redirect (safeAdminNext)');
check('admin page kept', safeAdminNext('/admin/help') === '/admin/help');
check('admin page with query kept', safeAdminNext('/admin/users?page=2&q=ab%20c') === '/admin/users?page=2&q=ab%20c');
for (const bad of ['https://evil.example/x', '//evil.example', '/\\evil.example', '/admin/../api/x', '/admin//x', '/api/help/reply', 'javascript:alert(1)', '/admin/login', '/admin/logout', '/admin/login?next=/admin/help', '', null, undefined, 42, '/admin/' + 'a'.repeat(400)]) {
  check(`rejected: ${String(bad).slice(0, 40)}`, safeAdminNext(bad) === '/admin/dashboard');
}

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'sessiontest' });

function makeApp(secret, maxAge = 60_000) {
  const app = express();
  app.use(express.json());
  app.use(session({
    secret, store: new MongoSessionStore({ connection: mongoose.connection }),
    resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', maxAge },
  }));
  app.post('/login', (req, res) => req.session.regenerate(() => { req.session.isLoggedIn = true; req.session.save(() => res.sendStatus(204)); }));
  app.get('/me', (req, res) => res.status(req.session.isLoggedIn ? 200 : 401).json({ loggedIn: !!req.session.isLoggedIn }));
  app.get('/logout', (req, res) => req.session.destroy(() => res.sendStatus(204)));
  return app;
}
const cookieOf = res => (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
const sessions = () => mongoose.connection.collection('sessions');

console.log('\nsurvives a restart');
{
  const before = makeApp('stable-secret');
  const login = await request(before).post('/login');
  const cookie = cookieOf(login);
  check('login sets a session cookie', /connect\.sid=/.test(cookie), cookie);
  check('logged in before restart', (await request(before).get('/me').set('Cookie', cookie)).status === 200);
  const doc = await sessions().findOne({});
  check('session stored in MongoDB with an expiry', !!doc && typeof doc.session === 'string' && doc.expires instanceof Date);
  const idx = await sessions().indexes();
  check('TTL index on expires', idx.some(i => i.key.expires === 1 && i.expireAfterSeconds === 0), JSON.stringify(idx));

  const after = makeApp('stable-secret'); // a "restarted" server: new app, new store instance
  check('still logged in after restart (same SESSION_SECRET)', (await request(after).get('/me').set('Cookie', cookie)).status === 200);

  const otherSecret = makeApp('a-different-secret');
  check('not logged in if the secret changed', (await request(otherSecret).get('/me').set('Cookie', cookie)).status === 401);

  await request(after).get('/logout').set('Cookie', cookie);
  check('logout removes the stored session', (await sessions().countDocuments({})) === 0);
  check('logged out after logout', (await request(after).get('/me').set('Cookie', cookie)).status === 401);
}

console.log('\nexpiry');
{
  const app = makeApp('stable-secret', 1000);
  const cookie = cookieOf(await request(app).post('/login'));
  check('logged in while fresh', (await request(app).get('/me').set('Cookie', cookie)).status === 200);
  await sleep(1500);
  // Bypass the cookie's own expiry: send it anyway, as a stale tab would.
  check('expired session is refused', (await request(app).get('/me').set('Cookie', cookie)).status === 401);
}

console.log('\nsession fixation');
{
  const app = makeApp('stable-secret');
  const first = cookieOf(await request(app).post('/login'));
  const second = cookieOf(await request(app).post('/login').set('Cookie', first));
  check('login issues a new session id', first && second && first !== second);
}

console.log('\nlogin page renders');
{
  const view = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views', 'login.ejs');
  const html1 = await ejs.renderFile(view, { title: 'Admin Login', error: null, notice: 'Your session expired. Please log in again.', next: '/admin/help' });
  check('expired notice shown', html1.includes('Your session expired'));
  check('next carried in the form', html1.includes('name="next" value="/admin/help"'));
  const html2 = await ejs.renderFile(view, { title: 'Admin Login', error: null });
  check('renders without notice/next (old call shape)', !html2.includes('name="next"') && !html2.includes('session expired'));
  const html3 = await ejs.renderFile(view, { title: 'Admin Login', error: 'Invalid credentials', notice: 'x', next: '"><script>' });
  check('error wins over notice, and next is escaped', html3.includes('Invalid credentials') && !html3.includes('"><script>'));
}

await mongoose.disconnect(); await mongod.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
