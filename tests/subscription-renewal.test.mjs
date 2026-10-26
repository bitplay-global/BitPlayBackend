/**
 * Monthly pack renewals (helpers/subscriptionGrants.js).
 * Verifies: a new pack is on while paid, kept on renewal, off when the paid
 * period ends or is refunded, back on when re-subscribed; buyers from before
 * keep their permanent hashpower and get the pack again for each period they
 * renew after the cut-over (not for earlier ones); a renewal reported twice
 * never grants twice; claimed hashpower is never touched; sandbox never counts.
 * Run: node tests/subscription-renewal.test.mjs
 */
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const DAY = 864e5;
const now = Date.now();
const iso = ms => new Date(ms).toISOString();
process.env.REVENUECAT_WEBHOOK_AUTH = 'hook-secret';
process.env.REVENUECAT_SECRET_KEY = 'test-secret';
process.env.LEGACY_RENEWALS_FROM = iso(now - 2 * DAY);
const RC = new Map(); // appUserId -> subscriber
global.fetch = async (url) => {
  const id = decodeURIComponent(String(url).split('/subscribers/')[1] || '');
  if (!RC.has(id)) return { status: 404, ok: false, json: async () => ({}), text: async () => '' };
  return { status: 200, ok: true, json: async () => ({ subscriber: structuredClone(RC.get(id)) }), text: async () => '' };
};

const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
await mongoose.connect(mongod.getUri(), { dbName: 'subtest' });
const Purchase = (await import('../models/Purchase.js')).default;
const Plan = (await import('../models/SubscriptionPlan.js')).default;
const Mining = (await import('../models/UserMiningDetails.js')).default;
const Grant = (await import('../models/SubscriptionGrant.js')).default;
await Purchase.syncIndexes(); await Grant.syncIndexes();
const { reconcileSubscriptions, syncCustomer } = await import('../helpers/subscriptionGrants.js');
const { default: webhook } = await import('../routes/revenuecat_webhook.js');
const { default: purchases } = await import('../routes/api_routes/purchases.js');
const app = express(); app.use(express.json());
app.use('/webhooks/revenuecat', webhook); app.use('/api/purchases', purchases);

const plan = (await Plan.create({
  id: 'mini', name: 'Mini', plan_cost: 2, hashrate: 40, unit: 'Gh/s', duration: 1, bonus_percent: 0,
  maintenance_cost: 0, google_identifier: 'pack.mini:monthly', apple_identifier: 'com.bp.mini',
}))._id.toString();
let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const mining = async u => Mining.findOne({ user: u }).lean();
const hp = async u => (await mining(u))?.hashpower ?? 0;
const uid = () => new mongoose.Types.ObjectId().toString();
const hook = event => request(app).post('/webhooks/revenuecat').set('Authorization', 'hook-secret').send({ event });
let n = 0;
const entry = (over = {}) => ({
  product_plan_identifier: 'monthly', store: 'play_store', is_sandbox: false,
  original_purchase_date: iso(now - DAY), purchase_date: iso(now - DAY),
  expires_date: iso(now + 29 * DAY), store_transaction_id: `GPA.${++n}`, ...over,
});
const setEntry = (anon, over) => RC.set(anon, { subscriptions: { 'pack.mini': entry(over) } });
const buyViaApp = async (u, anon) => request(app).post(`/api/purchases/${u}`).send({
  plan_id: plan, product_identifier: 'pack.mini', revenuecat_customer_id: anon, price_paid: 2, currency: 'USD' });

console.log('\n--- new purchase: on while paid ---');
let u = uid(); let anon = '$RCAnonymousID:new1';
await Mining.collection.insertOne({ user: u, hashpower: 5, claimedHashpower: 5, purchasedHashpower: 0, rewarded_ads_watched: 0, random_ads_watched: 0, thirty_gh_rewarded_ads_watched: 0 });
setEntry(anon, {});
let r = await buyViaApp(u, anon);
check('purchase applied', r.status === 200, `${r.status} ${JSON.stringify(r.body)}`);
check('pack hashpower added (40 x2 = 80) on top of claimed 5', (await hp(u)) === 85, `hp ${await hp(u)}`);
let g = await Grant.findOne({ rc_customer_id: anon }).lean();
check('grant recorded: active, not legacy, with the paid-until date', g?.active === true && g.legacy === false && g.expires_at > new Date(), JSON.stringify(g));

console.log('\n--- renewal ---');
setEntry(anon, { purchase_date: iso(now), expires_date: iso(now + 30 * DAY), store_transaction_id: 'GPA.renew1' });
r = await hook({ type: 'RENEWAL', app_user_id: anon, original_app_user_id: anon, product_id: 'pack.mini' });
check('webhook renewal accepted', r.status === 200 && r.body.synced === 1, JSON.stringify(r.body));
check('hashpower kept, not doubled', (await hp(u)) === 85, `hp ${await hp(u)}`);
g = await Grant.findOne({ rc_customer_id: anon }).lean();
check('paid-until extended and logged', g.expires_at.getTime() === now + 30 * DAY && g.history.some(h => h.change === 'extend'), JSON.stringify(g.history));
r = await buyViaApp(u, anon);
check('app reporting the renewal as a purchase: 409, no second grant', r.status === 409 && (await hp(u)) === 85, `${r.status} hp ${await hp(u)}`);

console.log('\n--- paid period ends (cancelled / payment failed) ---');
setEntry(anon, { purchase_date: iso(now - 31 * DAY), expires_date: iso(now - 60_000), unsubscribe_detected_at: iso(now - 10 * DAY) });
await Grant.updateOne({ rc_customer_id: anon }, { $set: { expires_at: new Date(now - 60_000) } });
let t = await reconcileSubscriptions({ scope: 'due', delayMs: 0 });
check('hourly check turns it off', t.off === 1 && (await hp(u)) === 5, `${JSON.stringify(t)} hp ${await hp(u)}`);
const m = await mining(u);
check('claimed hashpower untouched, purchased back to 0', m.claimedHashpower === 5 && m.purchasedHashpower === 0, JSON.stringify(m));
t = await reconcileSubscriptions({ scope: 'due', delayMs: 0 });
check('running again changes nothing', t.customers === 0 && (await hp(u)) === 5);

console.log('\n--- store grace period keeps it on ---');
setEntry(anon, { purchase_date: iso(now), expires_date: iso(now - 60_000), grace_period_expires_date: iso(now + 3 * DAY) });
await syncCustomer(anon);
check('re-subscribed / in grace: back on', (await hp(u)) === 85, `hp ${await hp(u)}`);

console.log('\n--- refund ---');
setEntry(anon, { purchase_date: iso(now), refunded_at: iso(now) });
r = await hook({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', app_user_id: anon, original_app_user_id: anon });
check('refunded: off', r.status === 200 && (await hp(u)) === 5, `hp ${await hp(u)}`);

console.log('\n--- buyer from before renewals were honoured ---');
const v = uid(); const anonL = '$RCAnonymousID:legacy1';
await Mining.collection.insertOne({ user: v, hashpower: 80, claimedHashpower: 0, purchasedHashpower: 80, rewarded_ads_watched: 0, random_ads_watched: 0, thirty_gh_rewarded_ads_watched: 0 });
await Purchase.create({ user: v, plan_id: plan, product_identifier: 'pack.mini', revenuecat_customer_id: anonL,
  store_transaction_id: 'GPA.old', price_paid: 2, currency: 'USD', purchase_date: new Date(now - 90 * DAY),
  existing_hashpower: 0, updated_hashpower: 80 });
// Renewed 3 times, the last one before the cut-over: not granted here.
RC.set(anonL, { subscriptions: { 'pack.mini': entry({ original_purchase_date: iso(now - 90 * DAY), purchase_date: iso(now - 5 * DAY), expires_date: iso(now + 25 * DAY) }) } });
t = await reconcileSubscriptions({ scope: 'all', delayMs: 0 });
g = await Grant.findOne({ rc_customer_id: anonL }).lean();
check('tracked as legacy, renewals before the cut-over not granted', g?.legacy === true && g.active === false && (await hp(v)) === 80, `${JSON.stringify(g)} hp ${await hp(v)}`);
RC.set(anonL, { subscriptions: { 'pack.mini': entry({ original_purchase_date: iso(now - 90 * DAY), purchase_date: iso(now), expires_date: iso(now + 30 * DAY) }) } });
t = await reconcileSubscriptions({ scope: 'all', delayMs: 0 });
check('renewal after the cut-over: pack added again for the month (80 permanent + 80)', (await hp(v)) === 160, `hp ${await hp(v)} ${JSON.stringify(t)}`);
t = await reconcileSubscriptions({ scope: 'all', delayMs: 0 });
check('same renewal seen again: no second grant', (await hp(v)) === 160, `hp ${await hp(v)}`);
RC.set(anonL, { subscriptions: { 'pack.mini': entry({ original_purchase_date: iso(now - 90 * DAY), purchase_date: iso(now), expires_date: iso(now - 1000) }) } });
await Grant.updateOne({ rc_customer_id: anonL }, { $set: { expires_at: new Date(now - 1000) } });
await reconcileSubscriptions({ scope: 'due', delayMs: 0 });
check('month ends without renewal: back to the permanent 80', (await hp(v)) === 80, `hp ${await hp(v)}`);

console.log('\n--- never below zero, sandbox never counts ---');
const w = uid(); const anonS = '$RCAnonymousID:sb';
await Mining.collection.insertOne({ user: w, hashpower: 0, claimedHashpower: 0, purchasedHashpower: 0, rewarded_ads_watched: 0, random_ads_watched: 0, thirty_gh_rewarded_ads_watched: 0 });
await Purchase.create({ user: w, plan_id: plan, product_identifier: 'pack.mini', revenuecat_customer_id: anonS,
  price_paid: 2, currency: 'USD', purchase_date: new Date(now - 90 * DAY), existing_hashpower: 0, updated_hashpower: 80 });
RC.set(anonS, { subscriptions: { 'pack.mini': entry({ original_purchase_date: iso(now - 90 * DAY), purchase_date: iso(now), is_sandbox: true }) } });
await syncCustomer(anonS);
check('sandbox renewal: nothing', (await hp(w)) === 0);
await Grant.create({ user: w, plan_id: plan, product_identifier: 'pack.mini', rc_customer_id: 'x', rc_key: 'pack.mini', hashpower: 80, active: true, expires_at: new Date(now - 1) });
RC.set('x', { subscriptions: { 'pack.mini': entry({ expires_date: iso(now - 1) }) } });
await Purchase.create({ user: w, plan_id: plan, product_identifier: 'pack.mini', revenuecat_customer_id: 'x',
  price_paid: 2, currency: 'USD', existing_hashpower: 0, updated_hashpower: 0 });
await syncCustomer('x');
const mw = await mining(w);
check('removing more than the user has stops at 0', mw.hashpower === 0 && mw.purchasedHashpower === 0, JSON.stringify(mw));

console.log('\n--- webhook still needs its secret ---');
r = await request(app).post('/webhooks/revenuecat').set('Authorization', 'wrong').send({ event: { type: 'RENEWAL', app_user_id: anonL } });
check('renewal event without the secret: 401', r.status === 401);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await mongoose.disconnect(); await mongod.stop(); process.exit(fail ? 1 : 0);
