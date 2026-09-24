/**
 * scripts/recover-purchases.js credits purchases RevenueCat recorded but the
 * backend refused. Verifies: genuine refused purchases are applied exactly once
 * and credited like a live purchase; refunds, sandbox, old, renewal, non-plan
 * and already-applied transactions are left alone; a live retry of a recovered
 * purchase is recognised as a replay.
 */
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { execFileSync } from 'child_process';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

process.env.REVENUECAT_SECRET_KEY = 'test-secret';
const RC = new Map(); // appUserId -> subscriber
global.fetch = async (url) => {
  const id = decodeURIComponent(String(url).split('/subscribers/')[1] || '');
  if (!RC.has(id)) return { status: 404, ok: false, json: async () => ({}), text: async () => '' };
  return { status: 200, ok: true, json: async () => ({ subscriber: RC.get(id) }), text: async () => '' };
};

const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
await mongoose.connect(mongod.getUri(), { dbName: 'recoverytest' });
const Purchase = (await import('../models/Purchase.js')).default;
const Plan = (await import('../models/SubscriptionPlan.js')).default;
const Mining = (await import('../models/UserMiningDetails.js')).default;
await Purchase.syncIndexes();
const { findRecoverable, applyRecoverable, matchRefusals, parseNginxRefusals } = await import('../helpers/recoverPurchases.js');
const { rcIdsFromText, parsePair } = await import('../scripts/recover-purchases.js');
const { default: router } = await import('../routes/api_routes/purchases.js');
const app = express(); app.use(express.json()); app.use('/api/purchases', router);
const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const uid = () => new mongoose.Types.ObjectId().toString();
// The app never calls Purchases.logIn: RevenueCat files buyers under anonymous ids.
const rcOf = u => `$RCAnonymousID:${u.slice(-12)}`;
const pairOf = u => [{ userId: u, rcId: rcOf(u) }];
const hp = async u => (await Mining.findOne({ user: u }).lean())?.hashpower ?? 0;
const plan = await Plan.create({
  id: 'p100', name: 'Mini Miner Offer Pack - 100 GH/s', plan_cost: 9.99, hashrate: 100, unit: 'Gh/s', duration: 1,
  maintenance_cost: 0, google_identifier: 'bitplay.mini:offer-100', apple_identifier: 'com.bp.mini',
});
const SINCE = '2026-09-14';
const sub = (txn, date, extra = {}) => ({ product_plan_identifier: 'offer-100', purchase_date: date, original_purchase_date: date, store_transaction_id: txn, store: 'play_store', ...extra });
const statusOf = (rows, userId) => rows.filter(r => r.userId === userId).map(r => r.status === 'apply' ? 'apply' : r.reason);

console.log('\n--- refused Android purchase is recovered exactly once ---');
const android = uid();
RC.set(rcOf(android), { subscriptions: { 'bitplay.mini': sub('GPA.1', '2026-09-15T10:00:00Z') } });
let rows = await findRecoverable({ pairs: pairOf(android), since: SINCE });
check('found as apply', statusOf(rows, android)[0] === 'apply', JSON.stringify(statusOf(rows, android)));
check('dry run changed nothing', (await Purchase.countDocuments()) === 0 && (await hp(android)) === 0);
let results = await applyRecoverable(rows);
check('applied', results[0]?.result === 'applied', results[0]?.result);
check('credited like a live purchase (100 x2)', (await hp(android)) === 200, `hp ${await hp(android)}`);
const rec = await Purchase.findOne({ store_transaction_id: 'GPA.1' }).lean();
check('purchase row created (shows in admin panel)', !!rec && rec.status === 'completed' && String(rec.plan_id) === String(plan._id));
check('credited to the BitPlay user, filed under the RevenueCat id', rec && String(rec.user) === android && rec.revenuecat_customer_id === rcOf(android));
check('purchase date is the store date', rec && rec.purchase_date.toISOString() === '2026-09-15T10:00:00.000Z');
rows = await findRecoverable({ pairs: pairOf(android), since: SINCE });
check('second run: already applied', statusOf(rows, android)[0] === 'already applied', JSON.stringify(statusOf(rows, android)));
results = await applyRecoverable(rows);
check('second run applies nothing', results.length === 0 && (await hp(android)) === 200);

console.log('\n--- a live retry of a recovered purchase is a replay ---');
const r = await request(base).post(`/api/purchases/${android}`).send({ plan_id: plan._id.toString(), product_identifier: 'bitplay.mini', revenuecat_customer_id: rcOf(android), price_paid: 9.99, currency: 'USD' });
check('app retry after recovery: 409', r.status === 409, `status ${r.status}`);
check('still credited once', (await hp(android)) === 200);

console.log('\n--- iOS one-time purchase ---');
const ios = uid();
RC.set(rcOf(ios), { non_subscriptions: { 'com.bp.mini': [{ purchase_date: '2026-09-16T00:00:00Z', store_transaction_id: 'ios-9', store: 'app_store', price: { amount: 9.99, currency: 'USD' } }] } });
rows = await findRecoverable({ pairs: pairOf(ios), since: SINCE });
results = await applyRecoverable(rows);
check('applied', results[0]?.result === 'applied' && (await hp(ios)) === 200, results[0]?.result);
check('RevenueCat price recorded', (await Purchase.findOne({ store_transaction_id: 'ios-9' }).lean())?.price_paid === 9.99);

console.log('\n--- plan stored as a bare sku with a stray space (the real 80 GH/s plan) ---');
const plan80 = await Plan.create({
  id: 'p80', name: 'Mini Miner Pack - 80 GH/s', plan_cost: 4.99, hashrate: 80, unit: 'Gh/s', duration: 1,
  maintenance_cost: 0, google_identifier: ' bitplay.m80', apple_identifier: 'com.bp.m80',
});
const buyer80 = uid();
RC.set(rcOf(buyer80), { subscriptions: { 'bitplay.m80': { product_plan_identifier: 'mini-minor-pack-80gh', purchase_date: '2026-09-16T17:08:00Z', original_purchase_date: '2026-09-16T17:08:00Z', store_transaction_id: 'GPA.80-1', store: 'play_store' } } });
rows = await findRecoverable({ pairs: pairOf(buyer80), since: SINCE });
check('sku:basePlan purchase of a bare-sku plan: found as apply', statusOf(rows, buyer80)[0] === 'apply' && rows[0]?.planId === plan80._id.toString(), JSON.stringify(statusOf(rows, buyer80)));
results = await applyRecoverable(rows);
check('and credited (80 x2)', results[0]?.result === 'applied' && (await hp(buyer80)) === 160, `${results[0]?.result} hp ${await hp(buyer80)}`);

console.log('\n--- left alone ---');
const cases = {
  refunded: [{ subscriptions: { 'bitplay.mini': sub('GPA.r', '2026-09-15T00:00:00Z', { refunded_at: '2026-09-16T00:00:00Z' }) } }, 'refunded'],
  sandbox: [{ subscriptions: { 'bitplay.mini': sub('GPA.s', '2026-09-15T00:00:00Z', { is_sandbox: true }) } }, 'sandbox / test purchase'],
  old: [{ subscriptions: { 'bitplay.mini': sub('GPA.o', '2026-08-01T00:00:00Z') } }, 'before --since'],
  renewal: [{ subscriptions: { 'bitplay.mini': sub('GPA.n..1', '2026-09-15T00:00:00Z', { original_purchase_date: '2026-08-15T00:00:00Z' }) } }, 'subscription renewal -- check by hand'],
  wrongBasePlan: [{ subscriptions: { 'bitplay.mini': sub('GPA.w', '2026-09-15T00:00:00Z', { product_plan_identifier: 'promo' }) } }, 'not a mining plan (e.g. Super Privileges)'],
  privilege: [{ non_subscriptions: { 'bitplay.super_privilege_5000pct': [{ purchase_date: '2026-09-15T00:00:00Z', store_transaction_id: 'GPA.p' }] } }, 'not a mining plan (e.g. Super Privileges)'],
};
for (const [name, [subscriber, reason]] of Object.entries(cases)) {
  const u = uid(); RC.set(rcOf(u), subscriber);
  rows = await findRecoverable({ pairs: pairOf(u), since: SINCE });
  results = await applyRecoverable(rows);
  check(`${name}: skipped (${reason})`, statusOf(rows, u)[0] === reason && results.length === 0 && (await hp(u)) === 0, JSON.stringify(statusOf(rows, u)));
}

const legacyUser = uid();
await Purchase.create({ user: legacyUser, plan_id: plan._id, product_identifier: 'bitplay.mini', price_paid: 9.99, currency: 'USD', purchase_date: new Date('2026-09-14T20:00:00Z'), status: 'completed', existing_hashpower: 0, updated_hashpower: 200 });
RC.set(rcOf(legacyUser), { subscriptions: { 'bitplay.mini': sub('GPA.L', '2026-09-15T00:00:00Z') } });
rows = await findRecoverable({ pairs: pairOf(legacyUser), since: SINCE });
check('older row with no transaction id nearby: flagged, not applied', /possibly already applied/.test(statusOf(rows, legacyUser)[0] || ''), JSON.stringify(statusOf(rows, legacyUser)));

const ghost = uid();
rows = await findRecoverable({ pairs: pairOf(ghost), since: SINCE });
check('unknown to RevenueCat: reported as error, nothing applied', rows[0]?.status === 'error');

console.log('\n--- bonus ---');
const { hashpowerForPlan } = await import('../helpers/grantPlanPurchase.js');
check('legacy plan keeps its fixed bonus (100 x2 +5%)', hashpowerForPlan({ _id: '692a89b9a6ff597e727676a5', hashrate: 100 }) === 210);
check("plan's own bonus_percent wins", hashpowerForPlan({ _id: '692a89b9a6ff597e727676a5', hashrate: 100, bonus_percent: 20 }) === 240);
check('bonus_percent 0 means no bonus', hashpowerForPlan({ _id: '692a89b9a6ff597e727676a5', hashrate: 100, bonus_percent: 0 }) === 200);
check('invalid bonus_percent falls back', hashpowerForPlan({ _id: '692a89b9a6ff597e727676a5', hashrate: 100, bonus_percent: 'abc' }) === 210);

console.log('\n--- matching RevenueCat buyers to accounts by time ---');
const nginx = [
  `1.2.3.4 - - [15/Sep/2026:10:00:05 +0000] "POST /api/purchases/${android} HTTP/1.1" 400 71 "-" "okhttp/4.12.0"`,
  `1.2.3.4 - - [16/Sep/2026:05:30:20 +0530] "POST /api/purchases/${ios} HTTP/1.1" 503 90 "-" "BitPlay/282"`,
  `5.6.7.8 - - [15/Sep/2026:10:00:09 +0000] "POST /api/purchases/${ghost} HTTP/1.1" 200 400 "-" "okhttp/4.12.0"`,
  `5.6.7.8 - - [15/Sep/2026:10:00:09 +0000] "GET /api/purchases/${ghost} HTTP/1.1" 404 10 "-" "okhttp/4.12.0"`,
  `9.9.9.9 - - [17/Sep/2026:08:00:03 +0000] "POST /api/privileges/${legacyUser} HTTP/1.1" 503 90 "-" "okhttp/4.12.0"`,
].join('\n');
const refusals = parseNginxRefusals(nginx);
check('refused purchase and privilege POSTs are read (200 and GET ignored)', refusals.length === 3 && refusals.some(x => x.userId === legacyUser) && !refusals.some(x => x.userId === ghost), JSON.stringify(refusals));
check('log time zones honoured', refusals.find(x => x.userId === ios)?.at.toISOString() === '2026-09-16T00:00:20.000Z');
let m = await matchRefusals({ refusals, rcIds: [rcOf(android), rcOf(ios)], since: SINCE });
check('each buyer paired with the account refused seconds after the purchase',
  m.pairs.length === 2 && m.pairs.some(x => x.rcId === rcOf(android) && x.userId === android) && m.pairs.some(x => x.rcId === rcOf(ios) && x.userId === ios),
  JSON.stringify(m));
const other = uid();
m = await matchRefusals({ refusals: [...refusals, { userId: other, at: new Date('2026-09-15T10:02:00Z'), status: 400 }], rcIds: [rcOf(android)], since: SINCE });
check('two accounts refused near one purchase: ambiguous, not paired', m.pairs.length === 0 && /ambiguous/.test(m.problems[0]?.reason), JSON.stringify(m));
m = await matchRefusals({ refusals: [{ userId: other, at: new Date('2026-09-15T12:00:00Z'), status: 400 }], rcIds: [rcOf(android)], since: SINCE });
check('refusal hours away: not paired', m.pairs.length === 0 && /no refused purchase call/.test(m.problems[0]?.reason), JSON.stringify(m));
check('unpaired customer shows what they bought', /bitplay\.mini:offer-100 @ 2026-09-15 10:00 UTC/.test(m.problems[0]?.bought?.[0] || ''), JSON.stringify(m.problems[0]));
m = await matchRefusals({ refusals, rcIds: ['$RCAnonymousID:unknown'], since: SINCE });
check('unknown RevenueCat id: reported, not paired', m.pairs.length === 0 && /RevenueCat/.test(m.problems[0]?.reason));

console.log('\n--- inputs ---');
const pasted = `Customer  $RCAnonymousID:0f1e2d3c4b5a69788796a5b4c3d2e1f0  Sep 15\n  $RCAnonymousID:abc123  again $RCAnonymousID:abc123`;
check('RevenueCat ids picked out of pasted dashboard text', JSON.stringify(rcIdsFromText(pasted)) === JSON.stringify(['$RCAnonymousID:0f1e2d3c4b5a69788796a5b4c3d2e1f0', '$RCAnonymousID:abc123']), JSON.stringify(rcIdsFromText(pasted)));
check('--pair parsed', parsePair(`${android}=$RCAnonymousID:abc`).rcId === '$RCAnonymousID:abc');
let pairErr = ''; try { parsePair('nope=x'); } catch (e) { pairErr = e.message; }
check('--pair with a bad user id refused', /--pair must be/.test(pairErr));
let cliError = '';
try {
  execFileSync(process.execPath, ['scripts/recover-purchases.js', '--pair', `${android}=$RCAnonymousID:abc`], { env: { PATH: process.env.PATH }, encoding: 'utf8', stdio: 'pipe' });
} catch (e) { cliError = `${e.stdout}${e.stderr}`; }
check('script refuses to run without --since', /--since YYYY-MM-DD is required/.test(cliError), cliError.slice(0, 160));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
server.close(); await mongoose.disconnect(); await mongod.stop(); process.exit(fail ? 1 : 0);
