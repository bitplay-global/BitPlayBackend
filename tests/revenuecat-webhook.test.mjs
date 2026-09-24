/**
 * POST /webhooks/revenuecat records purchases the app failed to sync.
 * Verifies: bad/missing auth refused; a genuine purchase is recorded once and
 * only after RevenueCat confirms it; replays and the app-sync/webhook
 * double-report grant hashpower once; refunded, sandbox, renewal and
 * unmatched events grant nothing.
 */
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

process.env.REVENUECAT_WEBHOOK_AUTH = 'hook-secret';
process.env.REVENUECAT_SECRET_KEY = 'test-secret';
const RC = new Map(); // appUserId -> subscriber
global.fetch = async (url) => {
  const id = decodeURIComponent(String(url).split('/subscribers/')[1] || '');
  if (!RC.has(id)) return { status: 404, ok: false, json: async () => ({}), text: async () => '' };
  return { status: 200, ok: true, json: async () => ({ subscriber: RC.get(id) }), text: async () => '' };
};

const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
await mongoose.connect(mongod.getUri(), { dbName: 'hooktest' });
const Purchase = (await import('../models/Purchase.js')).default;
const Plan = (await import('../models/SubscriptionPlan.js')).default;
const Mining = (await import('../models/UserMiningDetails.js')).default;
await Purchase.syncIndexes();
const { default: webhook } = await import('../routes/revenuecat_webhook.js');
const { default: purchases } = await import('../routes/api_routes/purchases.js');
const app = express(); app.use(express.json());
app.use('/webhooks/revenuecat', webhook); app.use('/api/purchases', purchases);
const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const plan = (await Plan.create({
  id: 'cheap', name: 'cheap', plan_cost: 10, hashrate: 10, unit: 'Gh/s', duration: 1,
  maintenance_cost: 0, google_identifier: 'plan.cheap:monthly', apple_identifier: 'com.bp.cheap',
}))._id.toString();
let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const hp = async u => (await Mining.findOne({ user: u }).lean())?.hashpower ?? 0;
const uid = () => new mongoose.Types.ObjectId().toString();
const send = (event, auth = 'hook-secret') => {
  const r = request(base).post('/webhooks/revenuecat');
  return (auth === null ? r : r.set('Authorization', auth)).send({ event });
};
let n = 0;
// Registers the purchase with the mocked RevenueCat and returns a matching event.
const buy = (over = {}, sub = {}) => {
  const anon = `$RCAnonymousID:anon${++n}`;
  const txn = `GPA.wh-${n}`;
  RC.set(anon, { subscriptions: { 'plan.cheap': {
    product_plan_identifier: 'monthly', purchase_date: new Date().toISOString(),
    store_transaction_id: txn, store: 'play_store', ...sub } } });
  return { anon, txn, event: {
    type: 'INITIAL_PURCHASE', environment: 'PRODUCTION', product_id: 'plan.cheap',
    transaction_id: txn, app_user_id: anon, original_app_user_id: anon,
    purchased_at_ms: Date.now(), price_in_purchased_currency: 890, currency: 'CRC', ...over } };
};

console.log('\n--- auth ---');
let u = uid();
let b = buy({ subscriber_attributes: { bitplay_user_id: { value: u } } });
let r = await send(b.event, null);
check('no Authorization header: 401', r.status === 401, `status ${r.status}`);
r = await send(b.event, 'wrong');
check('wrong Authorization header: 401', r.status === 401, `status ${r.status}`);
check('and nothing granted', (await hp(u)) === 0);

console.log('\n--- genuine purchase ---');
r = await send(b.event);
check('recorded: 200 applied', r.status === 200 && r.body.applied === true, JSON.stringify(r.body));
check('hashpower = hashrate x2', (await hp(u)) === 20, `hp ${await hp(u)}`);
const row = await Purchase.findOne({ store_transaction_id: b.txn }).lean();
check('purchase row saved in the purchased currency', row?.currency === 'CRC' && row?.price_paid === 890, JSON.stringify(row));
r = await send(b.event);
check('same event redelivered: acknowledged, not granted twice', r.status === 200 && r.body.duplicate === true && (await hp(u)) === 20, `hp ${await hp(u)}`);

console.log('\n--- app sync and webhook both report the same purchase ---');
const u2 = uid();
b = buy({ subscriber_attributes: { bitplay_user_id: { value: u2 } } });
let s = await request(base).post(`/api/purchases/${u2}`).send({
  plan_id: plan, product_identifier: 'plan.cheap', revenuecat_customer_id: b.anon, price_paid: 1, currency: 'USD' });
check('app sync applies it', s.status === 200 && (await hp(u2)) === 20, `status ${s.status} hp ${await hp(u2)}`);
r = await send(b.event);
check('webhook after app sync: duplicate, no double grant', r.status === 200 && r.body.duplicate === true && (await hp(u2)) === 20, `hp ${await hp(u2)}`);
const u3 = uid();
b = buy({ subscriber_attributes: { bitplay_user_id: { value: u3 } } });
r = await send(b.event);
s = await request(base).post(`/api/purchases/${u3}`).send({
  plan_id: plan, product_identifier: 'plan.cheap', revenuecat_customer_id: b.anon, price_paid: 1, currency: 'USD' });
check('app sync after webhook: 409, no double grant', s.status === 409 && (await hp(u3)) === 20, `status ${s.status} hp ${await hp(u3)}`);

console.log('\n--- events that grant nothing ---');
const u4 = uid();
r = await send(buy({ type: 'RENEWAL', subscriber_attributes: { bitplay_user_id: { value: u4 } } }).event);
check('renewal ignored', r.status === 200 && (await hp(u4)) === 0);
r = await send(buy({ subscriber_attributes: { bitplay_user_id: { value: u4 } } }, { is_sandbox: true }).event);
check('sandbox purchase: acknowledged, nothing granted', r.status === 200 && (await hp(u4)) === 0, JSON.stringify(r.body));
r = await send(buy({ subscriber_attributes: { bitplay_user_id: { value: u4 } } }, { refunded_at: new Date().toISOString() }).event);
check('refunded purchase: acknowledged, nothing granted', r.status === 200 && (await hp(u4)) === 0, JSON.stringify(r.body));
r = await send(buy().event);
check('anonymous buyer with no user id: 200 unmatched, nothing granted', r.status === 200 && r.body.unmatched === 'user', JSON.stringify(r.body));
r = await send(buy({ product_id: 'no.such.product', subscriber_attributes: { bitplay_user_id: { value: u4 } } }).event);
check('unknown product: 200 unmatched', r.status === 200 && r.body.unmatched === 'plan' && (await hp(u4)) === 0, JSON.stringify(r.body));
r = await send({ type: 'INITIAL_PURCHASE', environment: 'PRODUCTION', product_id: 'plan.cheap', transaction_id: 'GPA.forged',
  app_user_id: '$RCAnonymousID:nobody', subscriber_attributes: { bitplay_user_id: { value: u4 } } });
check('event RevenueCat cannot confirm: not granted, retried (non-2xx)', r.status >= 500 && (await hp(u4)) === 0, `status ${r.status}`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
server.close(); await mongoose.disconnect(); await mongod.stop(); process.exit(fail ? 1 : 0);
