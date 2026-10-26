/**
 * Goodwill credit for pack renewals charged before 2026-10-26
 * (helpers/pastRenewals.js, helpers/bonusGrants.js).
 * Verifies: missed renewals are counted per subscription with the Buy 1 Get 1
 * hashpower; the one renewed after the cut-over is not counted (it is honoured
 * live); sandbox never counts; a credit adds hashpower until it expires and is
 * then removed; the same credit can never be given twice; claimed hashpower is
 * never touched.
 * Run: node tests/past-renewal-credit.test.mjs
 */
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const DAY = 864e5;
const now = Date.now();
const iso = ms => new Date(ms).toISOString();
process.env.REVENUECAT_SECRET_KEY = 'test-secret';
process.env.LEGACY_RENEWALS_FROM = iso(now - 2 * DAY);
const RC = new Map();
global.fetch = async (url) => {
  const id = decodeURIComponent(String(url).split('/subscribers/')[1] || '');
  if (!RC.has(id)) return { status: 404, ok: false, json: async () => ({}), text: async () => '' };
  return { status: 200, ok: true, json: async () => ({ subscriber: structuredClone(RC.get(id)) }), text: async () => '' };
};

const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
await mongoose.connect(mongod.getUri(), { dbName: 'bonustest' });
const Purchase = (await import('../models/Purchase.js')).default;
const Plan = (await import('../models/SubscriptionPlan.js')).default;
const Mining = (await import('../models/UserMiningDetails.js')).default;
const Bonus = (await import('../models/BonusGrant.js')).default;
await Bonus.syncIndexes();
const { findPastRenewals } = await import('../helpers/pastRenewals.js');
const { grantBonus, expireBonusGrants } = await import('../helpers/bonusGrants.js');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const mining = async u => Mining.findOne({ user: u }).lean();

const plan = await Plan.create({
  id: 'mini', name: 'Mini 80', plan_cost: 2, hashrate: 80, unit: 'Gh/s', duration: 1, bonus_percent: 0,
  maintenance_cost: 0, google_identifier: 'pack.mini:monthly', apple_identifier: 'com.bp.mini',
});
const users = mongoose.connection.collection('users');
async function buyer(anon, entry, start = 160) {
  const _id = new mongoose.Types.ObjectId();
  await users.insertOne({ _id, email: `${anon}@x.com`, name: anon });
  await Mining.collection.insertOne({ user: String(_id), hashpower: start + 5, claimedHashpower: 5, purchasedHashpower: start });
  await Purchase.create({ user: _id, plan_id: plan._id, product_identifier: 'pack.mini', revenuecat_customer_id: anon,
    price_paid: 2, currency: 'USD', purchase_date: new Date(entry.original_purchase_date), existing_hashpower: 0, updated_hashpower: start });
  RC.set(anon, { subscriptions: { 'pack.mini': { product_plan_identifier: 'monthly', store: 'play_store', is_sandbox: false, expires_date: iso(now + 20 * DAY), ...entry } } });
  return String(_id);
}

console.log('--- who missed renewals ---');
const a = await buyer('a', { original_purchase_date: iso(now - 95 * DAY), purchase_date: iso(now - 10 * DAY) }); // 3 renewals, all before cut-over
const b = await buyer('b', { original_purchase_date: iso(now - 62 * DAY), purchase_date: iso(now - 1 * DAY) }); // 2, the last honoured live
await buyer('c', { original_purchase_date: iso(now - 10 * DAY), purchase_date: iso(now - 10 * DAY) });           // never renewed
await buyer('d', { original_purchase_date: iso(now - 95 * DAY), purchase_date: iso(now - 10 * DAY), is_sandbox: true });
const { rows } = await findPastRenewals({ delayMs: 0 });
const row = id => rows.find(r => r.user_id === id);
check('3 missed renewals counted', row(a)?.est_unrewarded_renewals === 3, JSON.stringify(row(a)));
check('renewal after the cut-over not counted again', row(b)?.est_unrewarded_renewals === 1, JSON.stringify(row(b)));
check('never renewed / sandbox: not listed', rows.length === 2, JSON.stringify(rows.map(r => r.email)));
check('Buy 1 Get 1: 80 GH/s pack credits 160', row(a)?.gh_per_month === 160);

console.log('\n--- credit ---');
const key = `past-renewals:a:pack.mini`;
const until = new Date(now + 90 * DAY);
check('granted', (await grantBonus({ key, userId: a, hashpower: 160, expiresAt: until })) === 'granted');
let m = await mining(a);
check('hashpower +160, claimed untouched', m.hashpower === 325 && m.purchasedHashpower === 320 && m.claimedHashpower === 5, JSON.stringify(m));
check('same credit again: no-op', (await grantBonus({ key, userId: a, hashpower: 160, expiresAt: until })) === 'exists');
const both = await Promise.all([1, 2].map(() => grantBonus({ key: 'race', userId: b, hashpower: 160, expiresAt: until })));
check('two at once: only one granted', both.filter(x => x === 'granted').length === 1 && (await mining(b)).purchasedHashpower === 320, JSON.stringify(both));
check('user without a mining record: refused, nothing saved',
  await grantBonus({ key: 'nobody', userId: new mongoose.Types.ObjectId().toString(), hashpower: 160, expiresAt: until }).then(() => false, () => true)
  && !(await Bonus.exists({ key: 'nobody' })));

console.log('\n--- expiry ---');
check('not yet expired: kept', (await expireBonusGrants(new Date(now + 89 * DAY))) === 0 && (await mining(a)).hashpower === 325);
check('expired: removed', (await expireBonusGrants(new Date(now + 91 * DAY))) === 2);
m = await mining(a);
check('back to the original, claimed untouched', m.hashpower === 165 && m.purchasedHashpower === 160 && m.claimedHashpower === 5, JSON.stringify(m));
check('expiring again: nothing', (await expireBonusGrants(new Date(now + 92 * DAY))) === 0 && (await mining(a)).hashpower === 165);
check('still cannot be re-granted after expiry', (await grantBonus({ key, userId: a, hashpower: 160, expiresAt: new Date(now + 99 * DAY) })) === 'exists');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await mongoose.disconnect(); await mongod.stop(); process.exit(fail ? 1 : 0);
