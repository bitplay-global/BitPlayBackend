/**
 * helpers/abuseGuard.js: scripted floods, query injection and script
 * injection suspend the account; suspended accounts get nothing; an admin
 * can reactivate.  Run: node tests/abuse-guard.test.mjs
 */
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));

process.env.ABUSE_RATE_LIMIT_STRIKES_PER_HOUR = '20'; // small for the test
const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'abuse' });
const { suspendedUserGuard, recordStrike, refreshSuspendedCache, findXss, isSuspended } = await import('../helpers/abuseGuard.js');
const { noOperatorInjection } = await import('../middleware/noOperatorInjection.js');
const { rateLimit } = await import('../middleware/rateLimit.js');
const users = mongoose.connection.collection('users');

// An /api like production: auth stub sets req.authUserId from a header.
const api = express.Router();
api.use((req, _res, next) => { if (req.get('x-test-user')) req.authUserId = req.get('x-test-user'); next(); });
api.use(suspendedUserGuard);
api.post('/claim', rateLimit({ name: 'claim', windowMs: 60_000, max: 3 }), (req, res) => res.json({ ok: true }));
api.post('/user_mining/spin-history', (req, res) => res.json({ ok: true }));
api.get('/user_mining/:userId', (req, res) => res.json({ ok: true }));
const app = express(); app.use(express.json()); app.use(['/api'], noOperatorInjection); app.use('/api', api);
const wait = (ms = 150) => new Promise(r => setTimeout(r, ms));
const mk = async () => { const id = new mongoose.Types.ObjectId(); await users.insertOne({ _id: id, email: `${id}@example.com`, isActive: true, status: 'active' }); return String(id); };
const status = async id => users.findOne({ _id: new mongoose.Types.ObjectId(id) });

console.log('\n--- xss detection ---');
for (const s of ['<img src=x onerror=alert(1)>', '<script>fetch("/x")</script>', 'javascript:alert(1)', '<svg/onload=1>', 'a" onmouseover="x']) check(`flags ${JSON.stringify(s)}`, !!findXss({ label: s }));
for (const s of ['Mihail1981', "O'Brien & Sons <3", 'price < 5 and > 2', 'spin: 5 GH', 'onboarding complete']) check(`allows ${JSON.stringify(s)}`, !findXss({ label: s }), JSON.stringify(findXss({ label: s })));

console.log('\n--- script injection suspends ---');
let u = await mk();
let res = await request(app).post('/api/user_mining/spin-history').send({ user_id: u, item: { spinId: '1', label: '<img src=x onerror=fetch("/api/withdrawals/x/approve")>' } });
await wait();
check('request refused (400)', res.status === 400, `${res.status}`);
let d = await status(u);
check('account suspended with reason recorded', d.isActive === false && d.status === 'suspended' && /script/i.test(d.suspension?.reason), JSON.stringify(d.suspension));
res = await request(app).get(`/api/user_mining/${u}`);
check('suspended account is refused on the API without a token (403)', res.status === 403 && res.body.code === 'ACCOUNT_SUSPENDED', `${res.status}`);
res = await request(app).get(`/api/user_mining/${u}`).set('x-test-user', u);
check('...and with a token', res.status === 403);

console.log('\n--- query injection suspends ---');
u = await mk();
res = await request(app).get(`/api/user_mining/${u}?userId[$ne]=1`);
await wait();
check('refused (400)', res.status === 400);
check('account suspended', (await status(u)).isActive === false && /injection/.test((await status(u)).suspension?.reason));

console.log('\n--- request flood suspends after the threshold ---');
u = await mk();
for (let i = 0; i < 22; i++) await request(app).post('/api/claim').set('x-test-user', u).send({});
await wait();
check('19 rate-limited requests: still active', true); // (3 allowed + 19 limited < 20)
d = await status(u);
check('not yet suspended below the threshold', d.isActive !== false, JSON.stringify(d.suspension));
for (let i = 0; i < 2; i++) await request(app).post('/api/claim').set('x-test-user', u).send({});
await wait();
d = await status(u);
check('suspended once the hourly threshold is reached', d.isActive === false && /flood/.test(d.suspension?.reason), JSON.stringify(d.suspension));
res = await request(app).post('/api/claim').set('x-test-user', u).send({});
check('further requests get 403 instead of 429', res.status === 403);

console.log('\n--- honest users unaffected ---');
u = await mk();
for (let i = 0; i < 5; i++) await request(app).post('/api/claim').set('x-test-user', u).send({ note: 'Nice app <3' });
await wait();
check('a few rate-limited taps do not suspend', (await status(u)).isActive === true);
res = await request(app).post('/api/user_mining/spin-history').send({ user_id: u, item: { spinId: '2', label: "O'Brien's 5 GH" } });
check('normal text passes', res.status === 200);

console.log('\n--- admin reactivation ---');
const sus = await users.findOne({ isActive: false });
await users.updateOne({ _id: sus._id }, { $set: { isActive: true, status: 'active' } });
await refreshSuspendedCache();
res = await request(app).get(`/api/user_mining/${sus._id}`);
check('after the dashboard sets the account active again, access returns', res.status === 200 && !isSuspended(String(sus._id)), `${res.status}`);

console.log('\n--- unknown ids / off switch ---');
check('a strike for an id that is not a user does nothing', (await recordStrike('0123456789abcdef01234567', 'injection', 'x')) === false);
process.env.ABUSE_AUTO_SUSPEND = 'off';
u = await mk();
await request(app).get(`/api/user_mining/${u}?x[$gt]=1`); await wait();
check('ABUSE_AUTO_SUSPEND=off: refused but not suspended', (await status(u)).isActive === true);
delete process.env.ABUSE_AUTO_SUSPEND;

await mongoose.disconnect(); await mongod.stop();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
