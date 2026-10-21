/**
 * The server, not the app, decides how much mining power a reward adds.
 *
 * Audit of 2026-10-11: the app's `hashpower` increment was added as sent, so
 * accounts collected the +25 mining-start reward up to 72 times a day, reset
 * their own 60-a-day ad counter, and any forged amount was accepted. Also
 * covers the withdrawal warnings shown to admins (helpers/withdrawalRisk.js).
 *
 * Run: node tests/reward-grants.test.mjs
 */
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import ejs from 'ejs';
import path from 'path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  classifyGrant, decideGrant, START_REWARD_GH, BASE_AD_GH, MAX_REWARDED_ADS_PER_DAY, PRIVILEGE_ADS_PER_DAY,
} from '../helpers/rewardGrants.js';
import { unexplainedBalance, dayCapBtc, assessWithdrawals } from '../helpers/withdrawalRisk.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));

console.log('\n--- classification (shapes the current app sends) ---');
check('home mining start (+25, mining on, ad count unchanged)', classifyGrant({ hashpower: 25, mining_isactive: true, rewarded_ads_watched: 4 }) === 'start_reward');
check('home regular ad (+5.5 with ad count)', classifyGrant({ hashpower: 5.5, mining_isactive: true, rewarded_ads_watched: 5 }) === 'ad');
check('privilege screen ad', classifyGrant({ hashpower: 10, privilege_ads_watched: 3 }) === 'privilege_ad');
check('game reward', classifyGrant({ hashpower: 5, offset: -330 }) === 'game');
check('daily rewards screen (mining_isactive null)', classifyGrant({ hashpower: 10, mining_isactive: null, rewarded_ads_watched: null }) === 'game');
check('sync with 0 is no grant', classifyGrant({ hashpower: 0, mining_isactive: true }) === 'none');
check('negative / NaN / string junk is no grant', ['-50', -1, NaN, 'abc', null].every(h => classifyGrant({ hashpower: h }) === 'none'));

console.log('\n--- decisions (pure) ---');
let d = decideGrant({ hashpower: 25, mining_isactive: true }, { startRewardDay: '2026-10-11' }, { today: '2026-10-11' });
check('second start reward the same day: 0', d.granted === 0 && /already/.test(d.reason), JSON.stringify(d));
d = decideGrant({ hashpower: 25, mining_isactive: true }, { startRewardDay: '2026-10-11' }, { today: '2026-10-10' });
check('an EARLIER day (clock/timezone change) does not reopen it', d.granted === 0);
d = decideGrant({ hashpower: 1000, mining_isactive: true }, null, { today: '2026-10-11' });
check('start reward is at most 25 even if more is asked', d.granted === START_REWARD_GH && d.set.startRewardDay === '2026-10-11');
d = decideGrant({ hashpower: 100000 }, null, { today: '2026-10-11' });
check('forged game amount: at most 10', d.granted === 10, JSON.stringify(d));
d = decideGrant({ hashpower: 5.9, rewarded_ads_watched: 99 }, { rewarded_ads_watched: 3, adCountDay: '2026-10-11' }, { today: '2026-10-11' });
check('ad pays the server amount 5.5, counter +1 only', d.granted === BASE_AD_GH && d.set.rewarded_ads_watched === 4, JSON.stringify(d));
d = decideGrant({ hashpower: 20, privilege_ads_watched: 1 }, null, { today: '2026-10-11', privilegeGh: [10] });
check('privilege ad above own tier gets own tier', d.granted === 10);

// ---- integration: the real route against a real (in-memory) MongoDB ----
const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'rewardtest' });
const Mining = (await import('../models/UserMiningDetails.js')).default;
const Privilege = (await import('../models/AdMultiplierPrivilege.js')).default;
const DailyReward = (await import('../models/DailyReward.js')).default;
const { default: router } = await import('../routes/api_routes/user-mining-handles.js');
const app = express(); app.use(express.json()); app.use('/api/user_mining', router);
const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

const uid = () => new mongoose.Types.ObjectId().toString();
// "Today" and "tomorrow" in the user's local day, so the test doesn't age:
// a record's legacy day comes from its real updatedAt, which must not be
// later than the day the test pretends to be.
const isoDay = d => d.toISOString().slice(0, 10);
const appDay = (d, t) => `${isoDay(d).slice(8, 10)}/${isoDay(d).slice(5, 7)}/${isoDay(d).slice(0, 4)}, ${t}`;
const NOW = new Date(Date.now() + 330 * 60 * 1000); // IST
const TOMORROW = new Date(NOW.getTime() + 86400000), YESTERDAY = new Date(NOW.getTime() - 86400000);
const D1 = isoDay(NOW), D2 = isoDay(TOMORROW);
const DAY1 = appDay(NOW, '10:00:00 AM'), DAY2 = appDay(TOMORROW, '09:00:00 AM');
// The server ignores a phone date that is not "today" anywhere on Earth
// (helpers/clientTime.js), so the next day is simulated by moving the
// server's clock a day ahead for that request -- as it really happens.
const realNow = Date.now;
const post = async (body, local_time = DAY1) => {
  if (local_time === DAY2) Date.now = () => realNow() + 86400000;
  try {
    return await request(base).post('/api/user_mining')
      .send({ offset: -330, timezone: 'Asia/Kolkata', random_ads_watched: 0, local_time, ...body });
  } finally {
    Date.now = realNow;
  }
};
const rec = u => Mining.findOne({ user: u }).lean();
const claimed = async u => (await rec(u))?.claimedHashpower || 0;

console.log('\n--- start reward: once per local day ---');
let u = uid();
await post({ user_id: u, hashpower: 0, mining_isactive: true, start_time: Date.now(), rewarded_ads_watched: 0 });
let r = await post({ user_id: u, hashpower: 25, mining_isactive: true, rewarded_ads_watched: 0 });
check('first start of the day: +25', await claimed(u) === 25 && r.body.grant?.granted === 25, JSON.stringify(r.body.grant));
for (let i = 0; i < 5; i++) {
  await post({ user_id: u, hashpower: 0, mining_isactive: false, rewarded_ads_watched: 0 });
  await post({ user_id: u, hashpower: 25, mining_isactive: true, rewarded_ads_watched: 0 });
}
check('toggling mining off/on 5 more times adds nothing', await claimed(u) === 25, String(await claimed(u)));
r = await post({ user_id: u, hashpower: 25, mining_isactive: true, rewarded_ads_watched: 0 });
check('refusal is reported in the response', r.body.success === true && r.body.grant?.granted === 0 && /already/.test(r.body.grant?.reason));
await post({ user_id: u, hashpower: 25, mining_isactive: true, rewarded_ads_watched: 0 }, DAY2);
check('next local day: +25 again', await claimed(u) === 50, String(await claimed(u)));

console.log('\n--- regular ads: server-owned counter, 60 a day ---');
u = uid();
await post({ user_id: u, hashpower: 0, mining_isactive: true, start_time: Date.now(), rewarded_ads_watched: 0 });
for (let i = 1; i <= MAX_REWARDED_ADS_PER_DAY; i++) await post({ user_id: u, hashpower: 5.5, mining_isactive: true, rewarded_ads_watched: i });
r = await rec(u);
check('60 ads: 60 x 5.5', r.claimedHashpower === 60 * 5.5 && r.rewarded_ads_watched === 60, `${r.claimedHashpower} / ${r.rewarded_ads_watched}`);
r = await post({ user_id: u, hashpower: 5.5, mining_isactive: true, rewarded_ads_watched: 61 });
check('61st ad refused, ad_cap_reached', r.body.ad_cap_reached === true && await claimed(u) === 330);
await post({ user_id: u, hashpower: 0, mining_isactive: true, rewarded_ads_watched: 0 });
check('app sending count 0 no longer resets the server counter', (await rec(u)).rewarded_ads_watched === 60);
await post({ user_id: u, hashpower: 5.5, mining_isactive: true, rewarded_ads_watched: 1 });
check('...so the old bypass (reset then claim) pays nothing', await claimed(u) === 330);
u = uid();
await post({ user_id: u, hashpower: 0, mining_isactive: true, start_time: Date.now(), rewarded_ads_watched: 0 });
await post({ user_id: u, hashpower: 5.5, mining_isactive: true, rewarded_ads_watched: 1 });
await post({ user_id: u, hashpower: 5.5, mining_isactive: true, rewarded_ads_watched: 1 });
check('replayed ad (same count) pays once', await claimed(u) === 5.5);
await post({ user_id: u, hashpower: 0, mining_isactive: true, rewarded_ads_watched: 0 }, DAY2);
r = await rec(u);
check('a new day resets the count (session never settled)', r.rewarded_ads_watched === 0 && r.adCountDay === D2, `${r.rewarded_ads_watched} ${r.adCountDay}`);
await post({ user_id: u, hashpower: 5.5, mining_isactive: true, rewarded_ads_watched: 1 }, DAY2);
check('...and the first ad of the new day pays', await claimed(u) === 11);

console.log('\n--- records from before the change ---');
u = uid();
await Mining.collection.insertOne({ user: u, mining_isactive: true, start_time: Date.now(), claimedHashpower: 100, purchasedHashpower: 0, hashpower: 100, rewarded_ads_watched: 60, offset: -330, timezone: 'Asia/Kolkata', updatedAt: new Date(`${isoDay(YESTERDAY)}T08:00:00Z`) });
await post({ user_id: u, hashpower: 5.5, mining_isactive: true, rewarded_ads_watched: 1 });
check('yesterday\'s 60 does not block today', await claimed(u) === 105.5, String(await claimed(u)));
u = uid();
await Mining.collection.insertOne({ user: u, mining_isactive: true, start_time: Date.now(), claimedHashpower: 100, purchasedHashpower: 0, hashpower: 100, rewarded_ads_watched: 60, offset: -330, timezone: 'Asia/Kolkata', updatedAt: new Date(`${D1}T03:00:00Z`) });
await post({ user_id: u, hashpower: 5.5, mining_isactive: true, rewarded_ads_watched: 61 });
check('today\'s 60 still counts on deploy day', await claimed(u) === 100);

console.log('\n--- games and other rewards: <= 10 each, 500 a day ---');
u = uid();
await post({ user_id: u, hashpower: 0, mining_isactive: true, start_time: Date.now(), rewarded_ads_watched: 0 });
r = await post({ user_id: u, hashpower: 47273 });
check('forged 47,273 GH/s request: +10', await claimed(u) === 10 && r.body.grant?.granted === 10, JSON.stringify(r.body.grant));
for (let i = 0; i < 120; i++) await post({ user_id: u, hashpower: 5 });
r = await rec(u);
check('game rewards stop at 500 a day', r.claimedHashpower === 500 && r.gameGhToday === 500, `${r.claimedHashpower} ${r.gameGhToday}`);
await post({ user_id: u, hashpower: 5 }, DAY2);
check('next day: games pay again', await claimed(u) === 505);
await DailyReward.create({ day: null, isRecurring: true, rewardType: 'hashpower', amount: 25 });
u = uid();
await post({ user_id: u, hashpower: 0, mining_isactive: true, start_time: Date.now(), rewarded_ads_watched: 0 });
// the grant cap is cached for 5 minutes; a fresh route import is not possible
// here, so check the helper path that uses it directly
d = decideGrant({ hashpower: 25 }, null, { today: '2026-10-11', maxGameGrant: 25 });
check('an admin-configured 25 GH/s daily reward still pays in full', d.granted === 25);
for (const bad of [-500, 'abc']) {
  await post({ user_id: u, hashpower: bad });
}
check('negative / junk hashpower changes nothing', await claimed(u) === 0);

console.log('\n--- privilege ads ---');
u = uid();
await post({ user_id: u, hashpower: 0, mining_isactive: true, start_time: Date.now(), rewarded_ads_watched: 0 });
await post({ user_id: u, hashpower: 20, privilege_ads_watched: 1 });
check('no active privilege: nothing', await claimed(u) === 0);
await Privilege.create({ user: u, tier: '5000pct', multiplier: 50, product_identifier: 'x', price_paid: 1, expires_at: new Date(Date.now() + 86400000 * 30) });
await post({ user_id: u, hashpower: 20, privilege_ads_watched: 1 });
check('+5000% holder asking for 20 gets 10', await claimed(u) === 10);
for (let i = 2; i <= PRIVILEGE_ADS_PER_DAY + 5; i++) await post({ user_id: u, hashpower: 10, privilege_ads_watched: i });
check('50 privilege ads a day', await claimed(u) === 500, String(await claimed(u)));

console.log('\n--- Super Ad Miner track unchanged ---');
u = uid();
await post({ user_id: u, hashpower: 0, mining_isactive: true, start_time: Date.now(), rewarded_ads_watched: 0 });
await post({ user_id: u, hashpower: 9999, mining_isactive: true, thirty_gh_rewarded_ads_watched: 1 });
check('server-computed 5.5 x multiplier (no privilege: 5.5)', await claimed(u) === 5.5);

console.log('\n--- stock game bonus and trading ---');
u = uid();
await post({ user_id: u, hashpower: 0, mining_isactive: true, start_time: Date.now(), rewarded_ads_watched: 0 });
await post({ user_id: u, hashpower: 0, stock_game_bonus: 1000000 });
check('stock_game_bonus in the body is ignored', ((await rec(u)).stockGameBonus || 0) === 0);
await request(base).post('/api/user_mining/trading-history').send({ user_id: u, trade: { tradeId: 'L', won: false, miningGh: 50, earnedAt: Date.now(), entryPrice: 1, exitPrice: 2, direction: 'up' } });
await request(base).post('/api/user_mining/trading-history').send({ user_id: u, trade: { tradeId: 'W', won: true, miningGh: 99999, earnedAt: Date.now(), entryPrice: 1, exitPrice: 2, direction: 'up' } });
r = await rec(u);
check('stored trade reward: lost 0, won capped at 10', r.tradingHistory.find(t => t.tradeId === 'L').miningGh === 0 && r.tradingHistory.find(t => t.tradeId === 'W').miningGh === 10);
let c = await request(base).post('/api/user_mining/trading-claim').send({ user_id: u, tradeId: 'L' });
check('claiming a lost trade pays 0', c.body.reward === 0);
c = await request(base).post('/api/user_mining/trading-claim').send({ user_id: u, tradeId: 'W' });
check('claiming a won trade pays 10', c.body.reward === 10 && (await rec(u)).stockGameBonus === 10);
c = await request(base).post('/api/user_mining/trading-claim').send({ user_id: u, tradeId: 'W' });
check('claiming it again pays nothing more', (await rec(u)).stockGameBonus === 10);

console.log('\n--- streak still updates on a reward request ---');
u = uid();
await post({ user_id: u, hashpower: 0, mining_isactive: true, start_time: Date.now(), rewarded_ads_watched: 0 });
await post({ user_id: u, hashpower: 25, mining_isactive: true, rewarded_ads_watched: 0 });
r = await rec(u);
check('streak recorded for the day', r.streakLastDate === D1 && r.streakDays === 1, `${r.streakLastDate} ${r.streakDays}`);

// ---- withdrawal warnings ----
console.log('\n--- withdrawal warnings: unexplained balance (pure) ---');
const cap = dayCapBtc(0);
check('day cap ~9.07e-7 BTC for a free account', Math.abs(cap - 9.072e-7) < 1e-9, String(cap));
check('honest miner: no warning', unexplainedBalance({ dayAmounts: [8e-7, 9e-7, 5e-7], purchasedGh: 0, referralBtc: 0, depositBtc: 0, balanceBtc: 1.2e-6, paidOutBtc: 1e-6 }) === null);
let x = unexplainedBalance({ dayAmounts: [0.9, 9.67e-6], purchasedGh: 0, referralBtc: 0, depositBtc: 0, balanceBtc: 0, paidOutBtc: 0.000009 });
check('May payout e9385464 pattern (0.9 BTC day): flagged', x && x.impossibleDays === 2 && x.biggestDay === 0.9, JSON.stringify(x));
x = unexplainedBalance({ dayAmounts: [2.5e-8], purchasedGh: 0, referralBtc: 0, depositBtc: 0, balanceBtc: 0.01000003, paidOutBtc: 0 });
check('0.01 BTC on 2.5e-8 mined: flagged', x && x.excess > 0.0099);
check('purchased power raises the day cap', unexplainedBalance({ dayAmounts: [1e-5], purchasedGh: 20000, referralBtc: 0, depositBtc: 0, balanceBtc: 1e-5, paidOutBtc: 0 }) === null);
check('excess under one day of mining is not flagged', unexplainedBalance({ dayAmounts: [8.5e-7, 8.5e-7], purchasedGh: 0, referralBtc: 0, depositBtc: 0, balanceBtc: 0, paidOutBtc: 1.746e-6 + 4.2e-7 }) === null);
check('deposits and referrals explain a balance', unexplainedBalance({ dayAmounts: [], purchasedGh: 0, referralBtc: 1e-6, depositBtc: 0.002, balanceBtc: 0.002001, paidOutBtc: 0 }) === null);

console.log('\n--- withdrawal warnings: against the database ---');
const db = mongoose.connection.db;
const [farmer, other1, other2, honest] = [uid(), uid(), uid(), uid()];
await db.collection('users').insertMany([
  { _id: new mongoose.Types.ObjectId(farmer), email: 'farmer@example.com' },
  { _id: new mongoose.Types.ObjectId(other1), email: 'alt1@example.com' },
  { _id: new mongoose.Types.ObjectId(other2), email: 'alt2@example.com' },
]);
const D128 = v => mongoose.Types.Decimal128.fromString(String(v));
await db.collection('balancehistories').insertMany([
  { user: farmer, date: new Date('2026-04-30'), balances: { BTC: D128(2.86e-5) } },
  { user: honest, date: new Date('2026-10-01'), balances: { BTC: D128(9e-7) } },
  { user: honest, date: new Date('2026-10-02'), balances: { BTC: D128(9e-7) } },
]);
await db.collection('balances').insertMany([{ user: farmer, BTC_DEPOSIT: D128(0) }, { user: honest, BTC_DEPOSIT: D128(1e-6) }]);
const W = (id, userId, toAddress, status, btc, extra = {}) => ({ _id: id, userId, toAddress, status, defaultAmountNumeric: D128(btc), amountNumeric: D128(btc), asset: 'BTC', ...extra });
await db.collection('withdrawals').insertMany([
  W('w-farmer', farmer, 'richardwiseman@speed.app', 'PENDING', 0.000025, { balanceDeducted: true }),
  W('w-alt1', other1, 'RichardWiseman@speed.app ', 'SENT', 0.000025),
  W('w-alt2', other2, 'richardwiseman@speed.app', 'FAILED', 0.00009),
  W('w-honest', honest, 'honest@speed.app', 'PENDING', 8e-7, { balanceDeducted: true }),
]);
const page = await db.collection('withdrawals').find({ _id: { $in: ['w-farmer', 'w-honest'] } }).toArray();
const risk = await assessWithdrawals(page);
const rf = risk.get('w-farmer'), rh = risk.get('w-honest');
check('farmer: unexplained balance', rf.unexplained && rf.unexplained.impossibleDays === 1, JSON.stringify(rf.unexplained));
check('farmer: address shared with 2 accounts (case/space-insensitive)', rf.sharedAddress?.accounts.length === 2 && rf.sharedAddress.sentToOthers === 1, JSON.stringify(rf.sharedAddress));
check('shared accounts carry their emails', rf.sharedAddress.accounts.map(a => a.email).sort().join() === 'alt1@example.com,alt2@example.com');
check('honest user: no warnings', rh.unexplained === null && rh.sharedAddress === null, JSON.stringify(rh));
check('empty page: empty result', (await assessWithdrawals([])).size === 0);

console.log('\n--- dashboard page renders the warnings ---');
const viewFile = path.resolve('views/withdraw.ejs');
const rows = page.map(w => ({ ...w, created_at: new Date(), displayAmount: '1', displayBtc: '0.00002500', risk: risk.get(w._id) }));
let html = '';
try {
  html = await ejs.renderFile(viewFile, { title: 'Withdrawals', user: { name: 'admin' }, withdrawals: rows, page: 1, limit: 10, total: 2, search: '' }, { async: false });
} catch (e) { html = 'RENDER ERROR ' + e.message; }
check('page renders', !html.startsWith('RENDER ERROR'), html.slice(0, 300));
check('shows UNEXPLAINED BALANCE and ADDRESS SHARED', html.includes('UNEXPLAINED BALANCE') && html.includes('ADDRESS SHARED: 2 OTHER ACCOUNTS'));
check('shows the other accounts\' emails', html.includes('alt1@example.com'));
check('honest row shows no warnings', html.includes('No warnings'));
check('approve prompt carries the warning text', /data-warnings="Unexplained balance: [^"]+Payout address also used by 2 other account\(s\), already paid to them 1 time\(s\)\."/.test(html));
check('approve prompt script is valid (no broken string)', html.includes("'\\n\\nApprove this withdrawal anyway?'"));

server.close();
await mongoose.disconnect();
await mongod.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
