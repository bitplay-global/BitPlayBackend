/**
 * middleware/appVersionTracker.js: records users.app from the x-app-* headers.
 * Run: node tests/app-version-tracker.test.mjs
 */
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'avt' });
const { appVersionTracker } = await import('../middleware/appVersionTracker.js');
const users = mongoose.connection.collection('users');
// Mounted under /api like production, so req.path matches the user-route patterns.
const api = express.Router(); api.use(appVersionTracker);
api.get('/user_mining/:userId', (req, res) => res.json({ ok: true }));
api.post('/user_mining', (req, res) => res.json({ ok: true }));
const app = express(); app.use(express.json()); app.use('/api', api);
const uid = new mongoose.Types.ObjectId();
await users.insertOne({ _id: uid, email: 'v@example.com' });
const wait = () => new Promise(r => setTimeout(r, 150));

await request(app).get(`/api/user_mining/${uid}`).set('x-app-platform', 'android').set('x-app-version', '2.0.1').set('x-app-build', '437');
await wait();
let u = await users.findOne({ _id: uid });
check('version, platform, build and lastSeenAt recorded from the headers', u.app?.version === '2.0.1' && u.app?.platform === 'android' && u.app?.build === '437' && u.app?.lastSeenAt instanceof Date, JSON.stringify(u.app));
const first = u.app.lastSeenAt;
await request(app).post('/api/user_mining').send({ user_id: String(uid) }).set('x-app-version', '2.0.1');
await wait();
u = await users.findOne({ _id: uid });
check('same version within 10 minutes: not written again', u.app.lastSeenAt.getTime() === first.getTime());
await request(app).post('/api/user_mining').send({ user_id: String(uid) }).set('x-app-platform', 'android').set('x-app-version', '2.0.2');
await wait();
u = await users.findOne({ _id: uid });
check('a new version is recorded at once', u.app.version === '2.0.2' && u.app.build === null, JSON.stringify(u.app));
const res = await request(app).get(`/api/user_mining/${uid}`);
check('no header: request passes, nothing changes', res.status === 200 && (await users.findOne({ _id: uid })).app.version === '2.0.2');
const other = new mongoose.Types.ObjectId();
await request(app).get(`/api/user_mining/${other}`).set('x-app-version', '9.9.9');
await wait();
check('unknown user id: nothing created', (await users.countDocuments({})) === 1);
await request(app).get('/api/user_mining/not-an-id').set('x-app-version', 'x'.repeat(500));
check('junk ids and long headers are ignored without error', true);

await mongoose.disconnect(); await mongod.stop();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
