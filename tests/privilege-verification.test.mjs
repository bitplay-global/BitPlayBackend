/**
 * The attack that produced the unpaid privileges: POST the endpoint directly,
 * name your own tier and price, receive a +10000% multiplier. Plus the replay
 * and tier-swap variants.
 */
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'privtest' });

// Stub RevenueCat: only these (appUserId, product) pairs were really bought.
const REAL_PURCHASES = new Map([
  ['rc_paid_user|bitplay.super_privilege_5000pct', { txn: 'txn_real_001', sandbox: false }],
  // A licence tester: a real transaction that was never charged.
  ['rc_test_user|bitplay.super_privilege_10000pct', { txn: 'txn_sandbox_001', sandbox: true }],
]);
// Customers RevenueCat knows about, whether or not they ever paid.
const KNOWN_CUSTOMERS = new Set(['$RCAnonymousID:a5f9b496768449bfb1cc09d8426db5d7']);
global.fetch = async (url, opts) => {
  const id = decodeURIComponent(String(url).split('/subscribers/')[1] || '');
  const nonSubs = {};
  for (const [key, txn] of REAL_PURCHASES) {
    const [user, product] = key.split('|');
    if (user === id) nonSubs[product] = [{
      store_transaction_id: txn.txn,
      purchase_date: '2026-09-01T00:00:00Z',
      store: 'play_store',
      is_sandbox: txn.sandbox,
    }];
  }
  // KNOWN_CUSTOMERS exist in RevenueCat but may have bought nothing -- the
  // observed case: the SDK registered an anonymous customer, no purchase
  // followed, and a privilege still appeared in the database minutes later.
  if (Object.keys(nonSubs).length === 0) {
    if (KNOWN_CUSTOMERS.has(id)) {
      return { status: 200, ok: true, json: async () => ({ subscriber: { non_subscriptions: {} } }) };
    }
    return { status: 404, ok: false, json: async () => ({}) };
  }
  return { status: 200, ok: true, json: async () => ({ subscriber: { non_subscriptions: nonSubs } }) };
};

process.env.REVENUECAT_SECRET_KEY = 'test-secret';
const router = (await import('../routes/api_routes/privileges.js')).default;
const AdMultiplierPrivilege = (await import('../models/AdMultiplierPrivilege.js')).default;
await AdMultiplierPrivilege.syncIndexes();

const app = express();
app.use(express.json());
app.use('/api/privileges', router);
const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}`; // one server: see note in app-user-auth.test.mjs

const ATTACKER = new mongoose.Types.ObjectId().toString();
const PAYER = new mongoose.Types.ObjectId().toString();
let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));

console.log('\n--- the attack that produced the unpaid rows ---');
let res = await request(base).post(`/api/privileges/${ATTACKER}`).send({
  tier: '10000pct',
  product_identifier: 'bitplay.super_privilege_10000pct',
  revenuecat_customer_id: '$RCAnonymousID:forged',
  price_paid: 8, currency: 'USD',
});
check('a purchase with no RevenueCat record is refused', res.status !== 200, `status ${res.status}`);
check('and nothing is granted', (await AdMultiplierPrivilege.countDocuments({ user: ATTACKER })) === 0);

res = await request(base).post(`/api/privileges/${ATTACKER}`).send({
  tier: '10000pct', product_identifier: 'bitplay.super_privilege_10000pct',
  revenuecat_customer_id: 'rc_paid_user', price_paid: 8, currency: 'USD',
});
check('paying for the cheap tier cannot claim the expensive one', res.status !== 200, `status ${res.status}`);

console.log('\n--- a genuine purchase still works ---');
res = await request(base).post(`/api/privileges/${PAYER}`).send({
  tier: '5000pct', product_identifier: 'bitplay.super_privilege_5000pct',
  revenuecat_customer_id: 'rc_paid_user', price_paid: 52, currency: 'USD',
});
check('a verified purchase is granted', res.status === 200, `status ${res.status} ${JSON.stringify(res.body).slice(0,120)}`);
const row = await AdMultiplierPrivilege.findOne({ user: PAYER });
check('the store transaction is recorded', row?.store_transaction_id === 'txn_real_001', String(row?.store_transaction_id));
check('the multiplier comes from the catalog', row?.multiplier === 50, String(row?.multiplier));

console.log('\n--- replay ---');
res = await request(base).post(`/api/privileges/${ATTACKER}`).send({
  tier: '5000pct', product_identifier: 'bitplay.super_privilege_5000pct',
  revenuecat_customer_id: 'rc_paid_user', price_paid: 52, currency: 'USD',
});
check("another account cannot reuse someone else's transaction", res.status !== 200, `status ${res.status}`);
check('still only one privilege from that purchase',
  (await AdMultiplierPrivilege.countDocuments({ store_transaction_id: 'txn_real_001' })) === 1);

console.log('\n--- the observed case: customer exists, Total Spent USD 0 ---');
res = await request(base).post(`/api/privileges/${ATTACKER}`).send({
  tier: '10000pct',
  product_identifier: 'bitplay.super_privilege_10000pct',
  revenuecat_customer_id: '$RCAnonymousID:a5f9b496768449bfb1cc09d8426db5d7',
  price_paid: 8, currency: 'USD',
});
check('a known customer who never purchased is refused', res.status !== 200, `status ${res.status}`);
check('and gets no privilege', (await AdMultiplierPrivilege.countDocuments({ user: ATTACKER })) === 0);

console.log('\n--- a test purchase is not a paid purchase ---');
res = await request(base).post(`/api/privileges/${ATTACKER}`).send({
  tier: '10000pct', product_identifier: 'bitplay.super_privilege_10000pct',
  revenuecat_customer_id: 'rc_test_user', price_paid: 8, currency: 'USD',
});
check('a sandbox/licence-tester purchase is refused', res.status !== 200, `status ${res.status}`);
check('and grants nothing', (await AdMultiplierPrivilege.countDocuments({ store_transaction_id: 'txn_sandbox_001' })) === 0);

console.log('\n--- an unset key must not reopen the hole ---');
delete process.env.REVENUECAT_SECRET_KEY;
res = await request(base).post(`/api/privileges/${ATTACKER}`).send({
  tier: '5000pct', product_identifier: 'bitplay.super_privilege_5000pct',
  revenuecat_customer_id: 'rc_paid_user', price_paid: 52, currency: 'USD',
});
check('fails closed when verification is unconfigured', res.status === 503, `status ${res.status}`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
server.close(); await mongoose.disconnect(); await mongod.stop();
process.exit(fail ? 1 : 0);
