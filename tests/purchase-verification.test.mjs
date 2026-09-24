/**
 * POST /api/purchases/:userId used to grant mining power on the client's word.
 * Verifies: forged purchases, plan/product swaps, replays, refunds and sandbox
 * purchases grant nothing; genuine subscription and one-time purchases still do.
 */
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

process.env.REVENUECAT_SECRET_KEY = 'test-secret';
const RC = new Map(); // appUserId -> subscriber
global.fetch = async (url) => {
  const id = decodeURIComponent(String(url).split('/subscribers/')[1] || '');
  if (!RC.has(id)) return { status: 404, ok: false, json: async () => ({}), text: async () => '' };
  return { status: 200, ok: true, json: async () => ({ subscriber: RC.get(id) }), text: async () => '' };
};

const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
await mongoose.connect(mongod.getUri(), { dbName: 'purchtest' });
const Purchase = (await import('../models/Purchase.js')).default;
const Plan = (await import('../models/SubscriptionPlan.js')).default;
const Mining = (await import('../models/UserMiningDetails.js')).default;
const Priv = (await import('../models/AdMultiplierPrivilege.js')).default;
await Purchase.syncIndexes(); await Priv.syncIndexes();
const { default: router } = await import('../routes/api_routes/purchases.js');
const app = express(); app.use(express.json()); app.use('/api/purchases', router);
const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}`; // one server: see note in app-user-auth.test.mjs

const mkPlan = async (name, hashrate, google, apple) => (await Plan.create({
  id: name, name, plan_cost: hashrate, hashrate, unit: 'Gh/s', duration: 1,
  maintenance_cost: 0, google_identifier: google, apple_identifier: apple,
}))._id.toString();
let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const cheap = await mkPlan('cheap', 10, 'plan.cheap:monthly', 'com.bp.cheap');
const pricey = await mkPlan('pricey', 5000, 'plan.pricey:monthly', 'com.bp.pricey');
const hp = async u => (await Mining.findOne({ user: u }).lean())?.hashpower ?? 0;
const buy = (u, body) => request(base).post(`/api/purchases/${u}`).send({ price_paid: 1, currency: 'USD', ...body });
const uid = () => new mongoose.Types.ObjectId().toString();

console.log('\n--- forged ---');
let u = uid(); let r = await buy(u, { plan_id: pricey, product_identifier: 'plan.pricey:monthly', revenuecat_customer_id: '$RCAnonymousID:nobody' });
check('no RevenueCat record: refused', r.status >= 400, `status ${r.status}`);
check('and no hashpower granted', (await hp(u)) === 0);
RC.set('$RCAnonymousID:broke', {}); // customer exists, bought nothing
r = await buy(u, { plan_id: pricey, product_identifier: 'plan.pricey:monthly', revenuecat_customer_id: '$RCAnonymousID:broke' });
check('customer with no purchases: refused', r.status >= 400, `status ${r.status}`);

console.log('\n--- plan/product swap ---');
RC.set('rc_cheap', { subscriptions: { 'plan.cheap:monthly': { purchase_date: '2026-09-01T00:00:00Z', store_transaction_id: 'GPA.cheap-1', store: 'play_store' } } });
r = await buy(u, { plan_id: pricey, product_identifier: 'plan.cheap:monthly', revenuecat_customer_id: 'rc_cheap' });
check('paid for cheap product, claimed expensive plan: 400', r.status === 400, `status ${r.status}`);
check('no hashpower', (await hp(u)) === 0);

console.log('\n--- genuine purchases still work ---');
r = await buy(u, { plan_id: cheap, product_identifier: 'plan.cheap:monthly', revenuecat_customer_id: 'rc_cheap' });
check('Google subscription (whole key) granted', r.status < 300, `status ${r.status} ${JSON.stringify(r.body).slice(0,140)}`);
check('hashpower = hashrate x2', (await hp(u)) === 20, `hp ${await hp(u)}`);
check('transaction recorded', !!(await Purchase.findOne({ store_transaction_id: 'GPA.cheap-1' })));
const u2 = uid();
RC.set('rc_split', { subscriptions: { 'plan.pricey': { product_plan_identifier: 'monthly', purchase_date: '2026-09-02T00:00:00Z', store_transaction_id: 'GPA.pricey-1', store: 'play_store' } } });
r = await buy(u2, { plan_id: pricey, product_identifier: 'plan.pricey:monthly', revenuecat_customer_id: 'rc_split' });
check('Google subscription (sku + base plan split) granted', r.status < 300, `status ${r.status}`);
const u3 = uid();
RC.set('rc_ios', { non_subscriptions: { 'com.bp.cheap': [{ purchase_date: '2026-09-03T00:00:00Z', store_transaction_id: 'ios-1', store: 'app_store' }] } });
r = await buy(u3, { plan_id: cheap, product_identifier: 'com.bp.cheap', revenuecat_customer_id: 'rc_ios' });
check('iOS one-time purchase granted', r.status < 300, `status ${r.status}`);

console.log('\n--- Android reports the bare sku (what a real Google purchase carries) ---');
const u4 = uid();
RC.set('rc_android', { subscriptions: { 'plan.pricey': { product_plan_identifier: 'monthly', purchase_date: '2026-09-06T00:00:00Z', store_transaction_id: 'GPA.bare-1', store: 'play_store' } } });
r = await buy(u4, { plan_id: pricey, product_identifier: 'plan.pricey', revenuecat_customer_id: 'rc_android' });
check('bare sku for a sku:basePlan plan: granted', r.status < 300, `status ${r.status} ${JSON.stringify(r.body).slice(0,140)}`);
check('and recorded, so it shows in the admin panel', !!(await Purchase.findOne({ store_transaction_id: 'GPA.bare-1' })));
RC.set('rc_android_cheap', { subscriptions: { 'plan.cheap': { product_plan_identifier: 'monthly', purchase_date: '2026-09-06T00:00:00Z', store_transaction_id: 'GPA.bare-2', store: 'play_store' } } });
r = await buy(uid(), { plan_id: pricey, product_identifier: 'plan.cheap', revenuecat_customer_id: 'rc_android_cheap' });
check('bare sku of a different plan: 400', r.status === 400, `status ${r.status}`);
RC.set('rc_android_otherbase', { subscriptions: { 'plan.pricey': { product_plan_identifier: 'promo', purchase_date: '2026-09-06T00:00:00Z', store_transaction_id: 'GPA.bare-3', store: 'play_store' } } });
r = await buy(uid(), { plan_id: pricey, product_identifier: 'plan.pricey', revenuecat_customer_id: 'rc_android_otherbase' });
check('bare sku but bought a different base plan: refused', r.status >= 400, `status ${r.status}`);
r = await buy(uid(), { plan_id: pricey, product_identifier: 'plan.pricey:promo', revenuecat_customer_id: 'rc_android_otherbase' });
check('explicit wrong base plan: 400', r.status === 400, `status ${r.status}`);
const spaced = await mkPlan('spaced', 80, ' plan.spaced', 'com.bp.spaced');
RC.set('rc_spaced', { non_subscriptions: { 'plan.spaced': [{ purchase_date: '2026-09-06T00:00:00Z', store_transaction_id: 'GPA.sp-1', store: 'play_store' }] } });
r = await buy(uid(), { plan_id: spaced, product_identifier: 'plan.spaced', revenuecat_customer_id: 'rc_spaced' });
check('plan id stored with a leading space still matches', r.status < 300, `status ${r.status}`);

const bare = await mkPlan('bare', 80, 'plan.bare', 'com.bp.bare');
RC.set('rc_bare', { subscriptions: { 'plan.bare': { product_plan_identifier: 'any-base', purchase_date: '2026-09-06T00:00:00Z', store_transaction_id: 'GPA.bb-1', store: 'play_store' } } });
r = await buy(uid(), { plan_id: bare, product_identifier: 'plan.bare:any-base', revenuecat_customer_id: 'rc_bare' });
check('sku:basePlan reported for a bare-sku plan: granted', r.status < 300, `status ${r.status}`);
r = await buy(uid(), { plan_id: bare, product_identifier: 'plan.cheap:monthly', revenuecat_customer_id: 'rc_cheap' });
check('another plan\'s sku:basePlan for a bare-sku plan: 400', r.status === 400, `status ${r.status}`);

console.log('\n--- replay, refund, sandbox ---');
r = await buy(uid(), { plan_id: cheap, product_identifier: 'plan.cheap:monthly', revenuecat_customer_id: 'rc_cheap' });
check('same transaction replayed into another account: 409', r.status === 409, `status ${r.status}`);
RC.set('rc_refund', { subscriptions: { 'plan.cheap:monthly': { purchase_date: '2026-09-04T00:00:00Z', store_transaction_id: 'GPA.r', refunded_at: '2026-09-05T00:00:00Z' } } });
r = await buy(uid(), { plan_id: cheap, product_identifier: 'plan.cheap:monthly', revenuecat_customer_id: 'rc_refund' });
check('refunded purchase: refused', r.status >= 400, `status ${r.status}`);
RC.set('rc_sandbox', { subscriptions: { 'plan.cheap:monthly': { purchase_date: '2026-09-04T00:00:00Z', store_transaction_id: 'GPA.s', is_sandbox: true } } });
r = await buy(uid(), { plan_id: cheap, product_identifier: 'plan.cheap:monthly', revenuecat_customer_id: 'rc_sandbox' });
check('sandbox purchase: refused', r.status >= 400, `status ${r.status}`);

console.log('\n--- index regression: rows without a transaction id never collide ---');
let collided = false;
try {
  for (const M of [Purchase, Priv]) {
    const c = M.collection;
    await c.insertMany([{ legacy: 1 }, { legacy: 2 }, { store_transaction_id: null }, { store_transaction_id: null }]);
  }
} catch (e) { collided = /E11000/.test(e.message); }
check('legacy rows and explicit nulls insert without E11000', !collided);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
server.close(); await mongoose.disconnect(); await mongod.stop(); process.exit(fail ? 1 : 0);
