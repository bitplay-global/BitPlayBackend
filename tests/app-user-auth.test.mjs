/**
 * App API identity. Tokens are signed with jsonwebtoken exactly as the auth
 * service signs them, so this also proves the two services agree on the format.
 * Run: JWT_LIB_DIR=../bitplay-auth node tests/app-user-auth.test.mjs
 */
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import mongoose from 'mongoose';
import { createRequire } from 'module';
import path from 'path';
import { MongoMemoryServer } from 'mongodb-memory-server';

const jwt = createRequire(path.resolve(process.env.JWT_LIB_DIR || '../bitplay-auth', 'package.json'))('jsonwebtoken');
process.env.JWT_SECRET = 'shared-test-secret';

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'appauth' });
const users = mongoose.connection.collection('users');
const A = new mongoose.Types.ObjectId(), B = new mongoose.Types.ObjectId(), OFF = new mongoose.Types.ObjectId(), TWOFA = new mongoose.Types.ObjectId();
await users.insertMany([
  { _id: A, email: 'a@x.com', isActive: true },
  { _id: B, email: 'b@x.com', isActive: true },
  { _id: OFF, email: 'off@x.com', isActive: false },
  { _id: TWOFA, email: '2fa@x.com', isActive: true, TwoFactorAuth: true, mfaVerifiedJtis: [] },
]);
const sign = (id, opts = {}, secret = process.env.JWT_SECRET) =>
  jwt.sign({ id: String(id), ...(opts.mfa ? { mfa: 'pending' } : {}) }, secret, { expiresIn: opts.exp ?? '1h', algorithm: 'HS256', ...(opts.jti ? { jwtid: opts.jti } : {}) });

const { default: apiRoutes } = await import('../routes/api.js');
const app = express();
app.use(express.json());
app.use(session({ secret: 't', resave: false, saveUninitialized: false }));
app.post('/__admin-login', (req, res) => { req.session.isLoggedIn = true; res.sendStatus(204); });
app.use('/api', apiRoutes);
// One persistent server. request(base) spins up and tears down an ephemeral
// server per call; across dozens of calls superagent occasionally reuses a
// socket and Node answers the garbled request with a bare 400, which showed up
// as random false failures.
const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const bal = (body, token) => { const r = request(base).post('/api/wallet/balance').send(body); return token ? r.set('Authorization', `Bearer ${token}`) : r; };
const ok = r => r.status < 400;

console.log('\n--- transition mode (ENFORCE_API_AUTH unset): installed builds keep working ---');
delete process.env.ENFORCE_API_AUTH;
let r = await bal({ userId: String(A), asset: 'BTC', amount: 0.0000001 });
check('no token: request still served (old app)', ok(r), `status ${r.status}`);
r = await request(base).get('/api/news?limit=1');
check('public route unaffected', r.status !== 401 && r.status !== 403, `status ${r.status}`);

console.log('\n--- a valid token pins the user ---');
const tA = sign(A);
r = await bal({ userId: String(A), asset: 'BTC', amount: 0.0000001 }, tA);
check('own account: allowed', ok(r), `status ${r.status} ${JSON.stringify(r.body)}`);
r = await bal({ userId: String(B), asset: 'BTC', amount: 0.0000009 }, tA);
check('overwrite someone else\'s balance: 403', r.status === 403 && r.body.code === 'USER_MISMATCH', `status ${r.status}`);
r = await request(base).get(`/api/withdrawals/user/${B}`).set('Authorization', `Bearer ${tA}`);
check('read someone else\'s withdrawals via URL: 403', r.status === 403, `status ${r.status}`);
r = await request(base).post('/api/security/switch').set('Authorization', `Bearer ${tA}`).send({ user_id: String(B) });
check('toggle someone else\'s 2FA: 403', r.status === 403, `status ${r.status}`);
r = await request(base).post('/api/withdrawals/create-speed-payment').set('Authorization', `Bearer ${tA}`).send({ amount: 1, metadata: { user_id: String(B) } });
check('withdraw as someone else via metadata.user_id: 403', r.status === 403, `status ${r.status}`);
r = await request(base).post(`/api/purchases/${B}`).set('Authorization', `Bearer ${tA}`).send({});
check('buy into someone else\'s account via URL: 403', r.status === 403, `status ${r.status}`);

console.log('\n--- bad tokens are always refused ---');
r = await bal({ userId: String(A), asset: 'BTC', amount: 0 }, sign(A, {}, 'wrong-secret'));
check('forged signature: 401', r.status === 401, `status ${r.status}`);
r = await bal({ userId: String(A), asset: 'BTC', amount: 0 }, sign(A, { exp: -10 }));
check('expired: 401', r.status === 401, `status ${r.status}`);
const none = Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from(JSON.stringify({ id: String(A) })).toString('base64url') + '.';
r = await bal({ userId: String(A), asset: 'BTC', amount: 0 }, none);
check('alg:none: 401', r.status === 401, `status ${r.status}`);
r = await bal({ userId: String(OFF), asset: 'BTC', amount: 0 }, sign(OFF));
check('deactivated account: 401', r.status === 401, `status ${r.status}`);

console.log('\n--- 2FA: same rule as the auth service ---');
const t2 = sign(TWOFA, { mfa: true, jti: 'session-1' });
r = await bal({ userId: String(TWOFA), asset: 'BTC', amount: 0 }, t2);
check('pending 2FA token: 401 MFA_REQUIRED', r.status === 401 && r.body.code === 'MFA_REQUIRED', `status ${r.status}`);
await users.updateOne({ _id: TWOFA }, { $set: { mfaVerifiedJtis: ['session-1'] } });
r = await bal({ userId: String(TWOFA), asset: 'BTC', amount: 0 }, t2);
check('after the code is verified: allowed', ok(r), `status ${r.status}`);

console.log('\n--- enforcement switched on ---');
process.env.ENFORCE_API_AUTH = 'true';
r = await bal({ userId: String(A), asset: 'BTC', amount: 0 });
check('no token + user id: 401', r.status === 401 && r.body.code === 'AUTH_REQUIRED', `status ${r.status}`);
r = await request(base).get(`/api/withdrawals/user/${A}`);
check('no token + user id in URL: 401', r.status === 401, `status ${r.status}`);
r = await request(base).get('/api/news?limit=1');
check('public route still open', r.status !== 401, `status ${r.status}`);
r = await bal({ userId: String(A), asset: 'BTC', amount: 0 }, tA);
check('valid own token: allowed', ok(r), `status ${r.status}`);
delete process.env.ENFORCE_API_AUTH;

console.log('\n--- admin-only operations ---');
for (const [m, p] of [['post', '/api/faqs/create'], ['delete', `/api/faqs/${A}`], ['post', '/api/subscriptionplans/create'], ['delete', `/api/subscriptionplans/${A}`], ['delete', `/api/subscriptionplans/usersub/${A}`], ['post', '/api/daily-rewards/create'], ['delete', `/api/daily-rewards/${A}`], ['post', '/api/firebase_tokens/custom-notification'], ['post', '/api/transactions/create'], ['delete', `/api/help/${A}/delete`]]) {
  r = await request(base)[m](p).send({ user_id: String(A), title: 'x', body: 'y' });
  check(`${m.toUpperCase()} ${p} anonymous: refused`, r.status === 401 || r.status === 403, `status ${r.status}`);
}
const admin = request.agent(base); await admin.post('/__admin-login');
r = await admin.post('/api/faqs/create').send({});
check('admin session reaches the handler', r.status !== 401 && r.status !== 403, `status ${r.status}`);
r = await admin.get(`/api/withdrawals/user/${B}`);
check('admin session can act on any user', r.status !== 401 && r.status !== 403, `status ${r.status}`);

console.log('\n--- balance input ---');
r = await bal({ userId: String(A), asset: 'BTC', amount: -5 }, tA);
check('negative BTC amount: 400', r.status === 400, `status ${r.status}`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
server.close(); await mongoose.disconnect(); await mongod.stop(); process.exit(fail ? 1 : 0);
