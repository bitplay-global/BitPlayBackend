/**
 * The withdrawal minimum follows the BTC price, so the app never shows a
 * minimum that Speed (0.5 USDT floor) then refuses. In Oct 2026 the dashboard
 * minimum was 0.000005 BTC while BTC was ~$83,000 (= $0.42): every user who
 * withdrew the displayed minimum got "at least 0.5 USDT (Speed minimum)".
 *
 * Run: node tests/withdrawal-limits.test.mjs
 */
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  speedMinimumBtc, getEffectiveWithdrawalLimits, belowMinimumMessage, setWithdrawalLimits,
} from '../helpers/withdrawalLimits.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));

console.log('\n--- Speed minimum in BTC (pure) ---');
check('at $83,293: 0.0000067 BTC ($0.55 with the 10% cushion, rounded up)', speedMinimumBtc(83293) === 0.0000067, String(speedMinimumBtc(83293)));
check('at $100,000: 0.0000055', speedMinimumBtc(100000) === 0.0000055, String(speedMinimumBtc(100000)));
check('at $50,000: 0.000011', speedMinimumBtc(50000) === 0.000011, String(speedMinimumBtc(50000)));
check('always worth at least 0.5 USDT', [30000, 65000, 83293, 100000, 250000].every(p => speedMinimumBtc(p) * p >= 0.5));
check('unknown price: 0 (dashboard value is used)', speedMinimumBtc(0) === 0 && speedMinimumBtc(NaN) === 0 && speedMinimumBtc(undefined) === 0);

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'limitstest' });
await setWithdrawalLimits(0.000005, 0.00009);

console.log('\n--- effective limits ---');
let l = await getEffectiveWithdrawalLimits({ priceFn: async () => 83293 });
check('dashboard 0.000005 at $83,293 is raised to 0.0000067', l.minBtc === 0.0000067 && l.raisedBySpeed === true, JSON.stringify(l));
check('max unchanged, dashboard value reported', l.maxBtc === 0.00009 && l.adminMinBtc === 0.000005);
l = await getEffectiveWithdrawalLimits({ priceFn: async () => 150000 });
check('at $150,000 the dashboard value is already enough', l.minBtc === 0.000005 && l.raisedBySpeed === false, JSON.stringify(l));
l = await getEffectiveWithdrawalLimits({ priceFn: async () => { throw new Error('offline'); } });
check('price fetch failing: dashboard value, priceKnown false', l.minBtc === 0.000005 && l.priceKnown === false);
await setWithdrawalLimits(0.00002, 0.00009);
l = await getEffectiveWithdrawalLimits({ priceFn: async () => 83293 });
check('a dashboard minimum above Speed\'s wins', l.minBtc === 0.00002 && l.raisedBySpeed === false);
await setWithdrawalLimits(0.000005, 0.00009);
l = await getEffectiveWithdrawalLimits({ priceFn: async () => 83293 });
check('message names the BTC amount and its dollar value', belowMinimumMessage(l) === 'Withdrawal amount must be at least 0.0000067 BTC (about $0.56).', belowMinimumMessage(l));

console.log('\n--- the routes ---');
process.env.MOBILE_APP_SECRET = process.env.MOBILE_APP_SECRET || 'test-secret';
const { default: router } = await import('../routes/api_routes/withdrawal_routes.js');
const app = express(); app.use(express.json()); app.use('/api/withdrawals', router);
const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
let res = await request(base).get('/api/withdrawals/limits');
check('GET /limits answers', res.status === 200, `status ${res.status}`);
check('GET /limits minimum is never below the dashboard value', res.body.minBtc >= 0.000005 && res.body.maxBtc === 0.00009, JSON.stringify(res.body));
check('GET /limits says whether Speed raised it', typeof res.body.raisedBySpeed === 'boolean' && typeof res.body.speedMinBtc === 'number');
if (res.body.speedMinBtc > 0) {
  check('(live price) the minimum is worth at least 0.5 USDT', res.body.minBtc >= res.body.speedMinBtc);
} else {
  console.log('  (no network: live-price check skipped)');
}

server.close();
await mongoose.disconnect();
await mongod.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
