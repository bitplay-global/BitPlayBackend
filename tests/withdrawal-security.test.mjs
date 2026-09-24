/**
 * Drives the real withdrawal routes against a real (in-memory) database, with
 * the Speed payout API stubbed so every send attempt is recorded instead of paid.
 *
 * The question each test answers is the same one: can money leave without an
 * admin approving it?
 */
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import axios from 'axios';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// Paths are relative to the repo root; run with: npm run test:withdrawals

process.env.SPEED_API_KEY = 'test-key-not-real';

// ---- Speed payout stub: nothing here reaches the network. -------------------
const speedCalls = [];
let totalPayoutAttempts = 0; // never reset, unlike speedCalls
axios.request = async (config) => {
  speedCalls.push(config);
  totalPayoutAttempts++;
  return { data: { id: `is_stub_${speedCalls.length}`, status: 'unpaid' } };
};

// create-speed-payment runs in a transaction, which needs a replica set.
const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
await mongoose.connect(mongod.getUri(), { dbName: 'wtest' });

const Withdrawal = (await import('../models/Withdrawal.js')).default;
const Balance = (await import('../models/Balance.js')).default;
const router = (await import('../routes/api_routes/withdrawal_routes.js')).default;

// ---- App with a switchable identity, mirroring the real middleware. ---------
let session = null; // null = not logged in; { isLoggedIn: true } = admin
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = session ?? {}; next(); });
app.use('/api/withdrawals', router);
const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}`; // one server: see note in app-user-auth.test.mjs

/** Headers a genuine mobile client sends -- these satisfy requireWithdrawalAccess. */
const MOBILE = {
  'x-app-id': 'bitplay-mobile',
  'x-app-platform': 'ios',
  'x-app-version': '60.0',
  'x-device-id': 'TEST-DEVICE-0001',
  'x-mobile-client': 'true',
};

const USER = new mongoose.Types.ObjectId().toString();
const ADDRESS = 'tester@speed.app';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') =>
  cond ? (pass++, console.log(`  PASS  ${name}`))
       : (fail++, console.log(`  FAIL  ${name}${detail ? `  -- ${detail}` : ''}`));

async function reset() {
  await Withdrawal.deleteMany({});
  await Balance.deleteMany({});
  await mongoose.connection.collection('users').deleteMany({});
  await mongoose.connection.collection('users').insertOne({ _id: USER, email: 't@t.com' });
  await Balance.create({
    user: USER,
    BTC: mongoose.Types.Decimal128.fromString('0.0100000000000000'),
    BTC_DEPOSIT: mongoose.Types.Decimal128.fromString('0.0100000000000000'),
  });
  speedCalls.length = 0;
  session = null;
}

// Amounts consistent with the live BTC price (the route rejects >15% mismatch).
const BTC_AMOUNT = 0.001;
// Use the live price when it is reachable so the route's 15% consistency check
// is genuinely exercised; fall back to a fixed rate when the sandbox has no
// network, which only makes the test more conservative (that check is skipped
// when the price is 0, and every other rule still applies).
let price = 0;
try { price = await (await import('../helpers/btcPrice.js')).getBtcUsdPriceCached(60000); } catch {}
const priceForAmounts = price > 0 ? price : 80000;
const USD_AMOUNT = Number((BTC_AMOUNT * priceForAmounts).toFixed(2));

console.log(`\n  (BTC/USD ${price > 0 ? price : `${priceForAmounts} (offline fallback)`}; test withdrawal ${BTC_AMOUNT} BTC = ${USD_AMOUNT} USDT)\n`);
console.log('--- A user submitting a withdrawal cannot cause a payout ---');

await reset();
let res = await request(base).post('/api/withdrawals').set(MOBILE).send({
  userId: USER, toAddress: ADDRESS, amountNumeric: USD_AMOUNT, amountBtc: BTC_AMOUNT,
});
check('POST / accepts the request', res.status === 201, `status ${res.status} ${JSON.stringify(res.body).slice(0,120)}`);
check('POST / creates it as PENDING', res.body?.withdrawal?.status === 'PENDING', res.body?.withdrawal?.status);
check('POST / never calls the payout API', speedCalls.length === 0, `${speedCalls.length} call(s)`);

await reset();
res = await request(base).post('/api/withdrawals/create-speed-payment').set(MOBILE).send({
  amount: USD_AMOUNT, baseAmount: BTC_AMOUNT, defaultAmountNumeric: BTC_AMOUNT,
  currency: 'USD', target_currency: 'USDT', speed_wallet_address: ADDRESS,
  metadata: { user_id: USER },
});
check('create-speed-payment accepts the request', res.status === 200, `status ${res.status} ${JSON.stringify(res.body).slice(0,140)}`);
check('create-speed-payment returns PENDING', res.body?.status === 'PENDING', res.body?.status);
check('create-speed-payment NEVER calls the payout API', speedCalls.length === 0, `${speedCalls.length} call(s) -- THIS WAS THE BUG`);
const stored = await Withdrawal.findById(res.body?.withdrawal_id);
check('stored record is PENDING, not SENT', stored?.status === 'PENDING', stored?.status);
check('no txHash was assigned', !stored?.txHash, String(stored?.txHash));
check('balance was reserved (deducted) for the request', stored?.balanceDeducted === true);

console.log('\n--- Approval is the only door, and it needs an admin ---');
const id = stored._id.toString();

session = null;
res = await request(base).patch(`/api/withdrawals/${id}/approve`).set(MOBILE).send({});
check('a mobile client cannot approve', res.status === 401, `status ${res.status}`);
check('refused approval triggers no payout', speedCalls.length === 0, `${speedCalls.length} call(s)`);

res = await request(base).patch(`/api/withdrawals/${id}/sent`).set(MOBILE).send({});
check('a mobile client cannot mark it SENT', res.status === 401, `status ${res.status}`);
res = await request(base).patch(`/api/withdrawals/${id}/confirm`).set(MOBILE).send({});
check('a mobile client cannot confirm it', res.status === 401, `status ${res.status}`);
res = await request(base).patch(`/api/withdrawals/${id}/reject`).set(MOBILE).send({});
check('a mobile client cannot reject it', res.status === 401, `status ${res.status}`);
res = await request(base).get('/api/withdrawals').set(MOBILE);
check('a mobile client cannot list every withdrawal', res.status === 401, `status ${res.status}`);

check('after all that, the record is still PENDING',
  (await Withdrawal.findById(id))?.status === 'PENDING');

console.log('\n--- An admin approving does pay, exactly once ---');
session = { isLoggedIn: true };
res = await request(base).patch(`/api/withdrawals/${id}/approve`).send({});
check('admin approval succeeds', res.status === 200, `status ${res.status} ${JSON.stringify(res.body).slice(0,140)}`);
check('the payout API is called exactly once', speedCalls.length === 1, `${speedCalls.length} call(s)`);
check('the payout goes to the requested address',
  String(speedCalls[0]?.data).includes(ADDRESS));
const afterApprove = await Withdrawal.findById(id);
check('record becomes SENT', afterApprove?.status === 'SENT', afterApprove?.status);

res = await request(base).patch(`/api/withdrawals/${id}/approve`).send({});
check('approving twice is refused', res.status === 400, `status ${res.status}`);
check('and does not pay a second time', speedCalls.length === 1, `${speedCalls.length} call(s)`);

console.log('\n--- Balance rules still hold ---');
await reset();
await request(base).post('/api/withdrawals/create-speed-payment').set(MOBILE).send({
  amount: USD_AMOUNT, baseAmount: BTC_AMOUNT, defaultAmountNumeric: BTC_AMOUNT,
  currency: 'USD', target_currency: 'USDT', speed_wallet_address: ADDRESS,
  metadata: { user_id: USER },
});
res = await request(base).post('/api/withdrawals/create-speed-payment').set(MOBILE).send({
  amount: USD_AMOUNT, baseAmount: BTC_AMOUNT, defaultAmountNumeric: BTC_AMOUNT,
  currency: 'USD', target_currency: 'USDT', speed_wallet_address: ADDRESS,
  metadata: { user_id: USER },
});
check('a second pending request is blocked', res.status === 409, `status ${res.status}`);
check('still no payout from either', speedCalls.length === 0, `${speedCalls.length} call(s)`);

await reset();
res = await request(base).post('/api/withdrawals/create-speed-payment').set(MOBILE).send({
  amount: Number((5 * priceForAmounts).toFixed(2)), baseAmount: 5, defaultAmountNumeric: 5,
  currency: 'USD', target_currency: 'USDT', speed_wallet_address: ADDRESS,
  metadata: { user_id: USER },
});
check('a withdrawal above the max limit is refused', res.status === 400, `status ${res.status}`);
check('and pays nothing', speedCalls.length === 0);

await reset();
res = await request(base).post('/api/withdrawals/create-speed-payment').send({
  amount: USD_AMOUNT, baseAmount: BTC_AMOUNT, defaultAmountNumeric: BTC_AMOUNT,
  currency: 'USD', target_currency: 'USDT', speed_wallet_address: ADDRESS,
  metadata: { user_id: USER },
});
check('a request with no mobile headers and no session is refused', res.status === 401 || res.status === 403, `status ${res.status}`);
check('and pays nothing', speedCalls.length === 0);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
console.log(`  payout attempts across the whole run: ${totalPayoutAttempts} (expected 1 -- the single admin approval)`);

server.close(); await mongoose.disconnect();
await mongod.stop();
process.exit(fail ? 1 : 0);
