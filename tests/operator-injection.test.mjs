/**
 * Query-operator injection, replayed from the production nginx log
 * (146.70.189.113, 18-21 Oct 2026): ?userId[$exists]=true and
 * ?userId[$nin][]=... made /api/wallet/history return other users' records.
 *
 * Run: node tests/operator-injection.test.mjs
 */
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { noOperatorInjection } from '../middleware/noOperatorInjection.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'injtest' });
const BalanceHistory = (await import('../models/BalanceHistory.js')).default;
const { default: balanceRouter } = await import('../routes/api_routes/balance.js');

const [alice, bob] = [new mongoose.Types.ObjectId().toString(), new mongoose.Types.ObjectId().toString()];
const D = v => mongoose.Types.Decimal128.fromString(String(v));
await BalanceHistory.create([
  { user: alice, date: new Date('2026-10-01'), balances: { BTC: D(1e-7) } },
  { user: bob, date: new Date('2026-10-02'), balances: { BTC: D(9e-7) } },
]);

const build = (guarded) => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  if (guarded) app.use(['/api', '/admin'], noOperatorInjection);
  app.use('/api/wallet', balanceRouter);
  app.post('/webhooks/revenuecat', (req, res) => res.json({ ok: true, email: req.body?.event?.subscriber_attributes?.$email?.value }));
  app.post('/api/echo', (req, res) => res.json({ ok: true }));
  return app;
};

console.log('\n--- without the guard (how it was) ---');
let res = await request(build(false)).get('/api/wallet/history?userId[$exists]=true');
check('the old hole: ?userId[$exists]=true returns OTHER users\' history', res.status === 200 && (res.body.balances || []).some(h => h.user === bob), JSON.stringify(res.body).slice(0, 120));

console.log('\n--- with the guard ---');
const app = build(true);
for (const q of ['userId[$exists]=true', `userId[$nin][]=${alice}`, `userId[$ne]=${alice}`, `userId[$gt]=`, `userId[$regex]=.*`, `userId[x]=1`]) {
  res = await request(app).get(`/api/wallet/history?${q}`);
  check(`refuses ?${q.slice(0, 40)}`, res.status === 400, `${res.status}`);
}
res = await request(app).get(`/api/wallet/history?userId=${alice}`);
check('a normal request still works, and only returns that user', res.status === 200 && res.body.balances.length === 1 && res.body.balances[0].user === alice, JSON.stringify(res.body).slice(0, 120));
res = await request(app).post('/api/echo').send({ userId: { $ne: null } });
check('refuses an operator in a JSON body', res.status === 400);
res = await request(app).post('/api/echo').send({ items: [{ deep: { $where: '1' } }] });
check('refuses an operator nested deep in a body', res.status === 400);
res = await request(app).post('/api/echo').send({ amountNumeric: { $numberDecimal: '0.97' }, note: 'costs $5' });
check('allows a Decimal128 amount and "$" inside text', res.status === 200);
res = await request(app).post('/webhooks/revenuecat').send({ event: { subscriber_attributes: { $email: { value: 'a@b.c' } } } });
check('RevenueCat webhook with "$email" attributes is not affected', res.status === 200 && res.body.email === 'a@b.c');
res = await request(app).get('/api/wallet/history?userId=a&userId=b');
check('repeated plain parameters are not refused by the guard', res.status !== 400 || !/Invalid request/.test(res.body?.error || ''));

await mongoose.disconnect();
await mongod.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
