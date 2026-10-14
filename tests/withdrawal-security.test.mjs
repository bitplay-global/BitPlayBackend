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
// How the stubbed Speed API answers: 'ok', 'http-error' (Speed refused: not
// paid), 'no-response' (timeout: outcome unknown), 'no-id' (200 without id).
let speedMode = 'ok';
let speedDelayMs = 0; // widens the window for simultaneous-request tests
axios.request = async (config) => {
  speedCalls.push(config);
  totalPayoutAttempts++;
  if (speedDelayMs) await new Promise(r => setTimeout(r, speedDelayMs));
  if (speedMode === 'http-error') {
    const e = new Error('Request failed with status code 400');
    e.response = { status: 400, statusText: 'Bad Request', data: { errors: [{ message: 'invalid withdraw request' }] } };
    throw e;
  }
  if (speedMode === 'no-response') {
    const e = new Error('timeout of 60000ms exceeded');
    e.code = 'ECONNABORTED';
    throw e;
  }
  if (speedMode === 'no-id') return { data: { status: 'unknown' } };
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
  speedMode = 'ok';
  speedDelayMs = 0;
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
// Speed stopped accepting USDT over Lightning on 2026-10-14 ("The
// withdraw_method is invalid"); Lightning payouts are bitcoin, in whole sats.
const sent = JSON.parse(speedCalls[0]?.data || '{}');
check('paid in SATS over Lightning, not USDT', sent.currency === 'SATS' && sent.target_currency === 'SATS' && sent.withdraw_method === 'lightning', JSON.stringify(sent));
check('amount is the BTC amount in whole sats', sent.amount === Math.floor(BTC_AMOUNT * 1e8) && Number.isInteger(sent.amount), String(sent.amount));
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

console.log('\n--- Simultaneous identical requests create one withdrawal (2026-10-10: four in 49 ms) ---');
await Withdrawal.init(); // make sure the one_pending_per_user index is built
const idx = await Withdrawal.collection.indexes();
check('one_pending_per_user index exists, unique, PENDING only',
  idx.some(i => i.name === 'one_pending_per_user' && i.unique && i.partialFilterExpression?.status === 'PENDING'), JSON.stringify(idx.map(i => i.name)));

await reset();
const burst = await Promise.all(Array.from({ length: 4 }, () =>
  request(base).post('/api/withdrawals').set(MOBILE).send({
    userId: USER, toAddress: ADDRESS, amountNumeric: USD_AMOUNT, amountBtc: BTC_AMOUNT,
  })));
const codes = burst.map(r => r.status).sort();
check('POST / x4 at once: exactly one accepted', codes.filter(c => c === 201).length === 1, `statuses ${codes}`);
check('POST / x4 at once: the rest get "already pending" (409)', codes.filter(c => c === 409).length === 3, `statuses ${codes}`);
check('POST / x4 at once: one PENDING withdrawal stored', (await Withdrawal.countDocuments({ userId: USER, status: 'PENDING' })) === 1);
check('409 names the pending withdrawal', burst.filter(r => r.status === 409).every(r => r.body?.pendingWithdrawalId), JSON.stringify(burst.find(r => r.status === 409)?.body));

await reset();
const lnBurst = await Promise.all(Array.from({ length: 4 }, () =>
  request(base).post('/api/withdrawals/create-speed-payment').set(MOBILE).send({
    amount: USD_AMOUNT, baseAmount: BTC_AMOUNT, defaultAmountNumeric: BTC_AMOUNT,
    currency: 'USD', target_currency: 'USDT', speed_wallet_address: ADDRESS,
    metadata: { user_id: USER },
  })));
const lnCodes = lnBurst.map(r => r.status).sort();
check('Lightning x4 at once: exactly one accepted', lnCodes.filter(c => c === 200).length === 1, `statuses ${lnCodes}`);
check('Lightning x4 at once: the rest get "already pending" (409)', lnCodes.filter(c => c === 409).length === 3, `statuses ${lnCodes} ${JSON.stringify(lnBurst.find(r => r.status !== 200 && r.status !== 409)?.body || {}).slice(0, 160)}`);
check('Lightning x4 at once: one PENDING withdrawal stored', (await Withdrawal.countDocuments({ userId: USER, status: 'PENDING' })) === 1);
const bal = await Balance.findOne({ user: USER }).lean();
check('Lightning x4 at once: balance reserved exactly once', Number(bal.BTC_DEPOSIT.toString()).toFixed(8) === (0.01 - BTC_AMOUNT).toFixed(8), `BTC_DEPOSIT ${bal.BTC_DEPOSIT}`);
check('Lightning burst pays nothing', speedCalls.length === 0);

await reset();
res = await request(base).post('/api/withdrawals').set(MOBILE).send({ userId: USER, toAddress: ADDRESS, amountNumeric: USD_AMOUNT, amountBtc: BTC_AMOUNT });
await Withdrawal.updateOne({ _id: res.body?.withdrawal?._id }, { $set: { status: 'FAILED' } });
res = await request(base).post('/api/withdrawals').set(MOBILE).send({ userId: USER, toAddress: ADDRESS, amountNumeric: USD_AMOUNT, amountBtc: BTC_AMOUNT });
check('after a rejected withdrawal, a new one can be requested', res.status === 201, `status ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);

// ---- Approval and rejection under double clicks, races and Speed failures --
const lnCreate = () => request(base).post('/api/withdrawals/create-speed-payment').set(MOBILE).send({
  amount: USD_AMOUNT, baseAmount: BTC_AMOUNT, defaultAmountNumeric: BTC_AMOUNT,
  currency: 'USD', target_currency: 'USDT', speed_wallet_address: ADDRESS, metadata: { user_id: USER },
});
const plainCreate = () => request(base).post('/api/withdrawals').set(MOBILE).send({
  userId: USER, toAddress: ADDRESS, amountNumeric: USD_AMOUNT, amountBtc: BTC_AMOUNT,
});
const approve = wid => request(base).patch(`/api/withdrawals/${wid}/approve`).send({});
const reject = wid => request(base).patch(`/api/withdrawals/${wid}/reject`).send({});
const deposit = async () => Number((await Balance.findOne({ user: USER }).lean()).BTC_DEPOSIT.toString()).toFixed(8);
const FULL = (0.01).toFixed(8), RESERVED = (0.01 - BTC_AMOUNT).toFixed(8);
const count = (arr, c) => arr.filter(r => r.status === c).length;

console.log('\n--- Double-clicking Approve pays once ---');
await reset();
let wid = (await lnCreate()).body.withdrawal_id;
session = { isLoggedIn: true }; speedDelayMs = 150;
let rs = await Promise.all([approve(wid), approve(wid), approve(wid)]);
check('Lightning: 3 simultaneous approvals -> one succeeds', count(rs, 200) === 1, `statuses ${rs.map(r => r.status)}`);
check('Lightning: the others are told it is already being approved (409)', count(rs, 409) === 2, `statuses ${rs.map(r => r.status)}`);
check('Lightning: Speed is called exactly once', speedCalls.length === 1, `${speedCalls.length} call(s)`);
check('Lightning: record is SENT', (await Withdrawal.findById(wid))?.status === 'SENT');
check('Lightning: balance taken once', (await deposit()) === RESERVED, await deposit());

await reset();
wid = (await plainCreate()).body.withdrawal._id;
session = { isLoggedIn: true }; speedDelayMs = 150;
rs = await Promise.all([approve(wid), approve(wid), approve(wid)]);
check('Plain: 3 simultaneous approvals -> one succeeds, Speed called once', count(rs, 200) === 1 && speedCalls.length === 1, `statuses ${rs.map(r => r.status)}, ${speedCalls.length} call(s)`);
check('Plain: balance deducted once even though it could cover more', (await deposit()) === RESERVED, await deposit());

console.log('\n--- Double-clicking Reject refunds once ---');
await reset();
wid = (await lnCreate()).body.withdrawal_id;
check('(balance reserved at creation)', (await deposit()) === RESERVED);
session = { isLoggedIn: true };
rs = await Promise.all([reject(wid), reject(wid), reject(wid)]);
check('3 simultaneous rejects -> one succeeds', count(rs, 200) === 1, `statuses ${rs.map(r => r.status)}`);
check('balance refunded exactly once', (await deposit()) === FULL, await deposit());
check('record is FAILED, nothing paid', (await Withdrawal.findById(wid))?.status === 'FAILED' && speedCalls.length === 0);

console.log('\n--- Approve and Reject at the same moment: one wins, consistently ---');
await reset();
wid = (await lnCreate()).body.withdrawal_id;
session = { isLoggedIn: true }; speedDelayMs = 150;
rs = await Promise.all([approve(wid), reject(wid)]);
{
  const w = await Withdrawal.findById(wid), d = await deposit();
  const paidPath = w.status === 'SENT' && speedCalls.length === 1 && d === RESERVED;
  const refundPath = w.status === 'FAILED' && speedCalls.length === 0 && d === FULL;
  check('either paid once and kept deducted, or refused and refunded -- never both', paidPath || refundPath,
    `status ${w.status}, ${speedCalls.length} call(s), deposit ${d}, responses ${rs.map(r => r.status)}`);
}

console.log('\n--- Speed refuses: nothing paid, balance back, admin can retry ---');
await reset();
wid = (await lnCreate()).body.withdrawal_id;
session = { isLoggedIn: true }; speedMode = 'http-error';
res = await approve(wid);
let w = await Withdrawal.findById(wid);
check('approval reports the Speed error', res.status === 500, `status ${res.status}`);
check('record stays PENDING with the claim released', w.status === 'PENDING' && w.approvalStartedAt == null, `${w.status} ${w.approvalStartedAt}`);
check('balance refunded', (await deposit()) === FULL, await deposit());
speedMode = 'ok';
res = await approve(wid);
check('a retry succeeds', res.status === 200, `status ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
check('and the balance is taken once again (net: paid once, deducted once)', (await deposit()) === RESERVED, await deposit());

console.log('\n--- Speed does not answer: locked, not refunded, not re-approvable ---');
for (const mode of ['no-response', 'no-id']) {
  await reset();
  wid = (await lnCreate()).body.withdrawal_id;
  session = { isLoggedIn: true }; speedMode = mode;
  res = await approve(wid);
  w = await Withdrawal.findById(wid);
  check(`${mode}: approval reports an unknown outcome (502)`, res.status === 502, `status ${res.status}`);
  check(`${mode}: withdrawal locked with a note to check Speed`, w.status === 'PENDING' && w.approvalStartedAt != null && /check this payment/i.test(w.approvalNote || ''), JSON.stringify({ s: w.status, a: w.approvalStartedAt, n: w.approvalNote }));
  check(`${mode}: balance NOT refunded (it may have been paid)`, (await deposit()) === RESERVED, await deposit());
  speedMode = 'ok';
  res = await approve(wid);
  check(`${mode}: approving again is refused and does not call Speed`, res.status === 409 && speedCalls.length === 1, `status ${res.status}, ${speedCalls.length} call(s)`);
  res = await reject(wid);
  check(`${mode}: after checking Speed, admin can reject; balance refunded once`, res.status === 200 && (await deposit()) === FULL, `status ${res.status}, deposit ${await deposit()}`);
}

console.log('\n--- An approval in progress cannot be rejected underneath it ---');
await reset();
wid = (await lnCreate()).body.withdrawal_id;
session = { isLoggedIn: true };
await Withdrawal.updateOne({ _id: wid }, { $set: { approvalStartedAt: new Date(), approvalStartedBy: 'other-admin' } });
res = await reject(wid);
check('reject while another approval is running is refused (409)', res.status === 409, `status ${res.status}`);
check('and refunds nothing', (await deposit()) === RESERVED);
await Withdrawal.updateOne({ _id: wid }, { $set: { approvalStartedAt: new Date(Date.now() - 10 * 60 * 1000) } });
res = await reject(wid);
check('a claim older than 5 minutes (crashed attempt) can be rejected', res.status === 200 && (await deposit()) === FULL, `status ${res.status}`);

console.log('\n--- No BTC amount on record: never paid without deducting ---');
await reset();
session = { isLoggedIn: true };
const legacy = await Withdrawal.create({ userId: USER, asset: 'USDT', chain: 'USDT', toAddress: ADDRESS, amountNumeric: mongoose.Types.Decimal128.fromString(String(USD_AMOUNT)) });
res = await approve(legacy._id);
w = await Withdrawal.findById(legacy._id);
check('approval refused when nothing can be deducted', res.status === 400, `status ${res.status} ${JSON.stringify(res.body).slice(0, 100)}`);
check('and Speed is not called', speedCalls.length === 0, `${speedCalls.length} call(s)`);
check('and the claim is released', w.status === 'PENDING' && w.approvalStartedAt == null);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
console.log(`  payout attempts across the whole run: ${totalPayoutAttempts} (each checked above; a double payout would have failed a check)`);

server.close(); await mongoose.disconnect();
await mongod.stop();
process.exit(fail ? 1 : 0);
