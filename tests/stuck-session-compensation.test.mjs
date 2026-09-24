/**
 * Compensation for mining sessions that were stuck without local_start_time.
 * Verifies: only days between the stuck start and the reset that the user
 * actually opened the app are paid, at hashpower x rate x 24h; each day is
 * paid once (balance, history row, referrer's 5%); re-running pays nothing;
 * still-stuck sessions are not paid yet; streaks are raised, never lowered.
 */
import fs from 'fs';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
await mongoose.connect(mongod.getUri(), { dbName: 'compensation' });
const Mining = (await import('../models/UserMiningDetails.js')).default;
const Balance = (await import('../models/Balance.js')).default;
const History = (await import('../models/BalanceHistory.js')).default;
const Recovery = (await import('../models/StuckSessionRecovery.js')).default;
const Referral = (await import('../models/ReferralRewardHistory.js')).default;
await Recovery.syncIndexes();
const C = await import('../helpers/stuckSessionCompensation.js');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const TZ = 'Asia/Kolkata', OFF = -330;
const users = mongoose.connection.collection('users');
const oid = () => new mongoose.Types.ObjectId();
const dep = async u => parseFloat((await Balance.findOne({ user: u }).lean())?.BTC_DEPOSIT?.toString() || '0');
const mkMining = (user, extra) => Mining.create({ user, rewarded_ads_watched: 0, random_ads_watched: 0, offset: OFF, timezone: TZ, hashpower: 0, ...extra });
// A request in the user's local (IST) morning of the given day, as nginx logs it (UTC).
const req = (id, day) => {
  const [y, m, d] = day.split('-');
  return `1.1.1.1 - - [${d}/${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]}/${y}:04:00:00 +0000] "GET /api/user_mining/${id} HTTP/1.1" 200 10 "-" "okhttp/4.12.0"`;
};
const PER_DAY = 805 * C.BTC_PER_GH_PER_DAY;

// Parent (referrer) and the Rishabh-like child.
const parent = oid(), rishabh = oid(), steady = oid(), stillStuck = oid(), partlyPaid = oid();
await users.insertMany([
  { _id: parent, email: 'parent@x.com', referralCode: 'PARENT1', isActive: true },
  { _id: rishabh, email: 'rishabh@x.com', referralUsed: 'PARENT1', isActive: true },
  { _id: steady, email: 'steady@x.com', isActive: true },
  { _id: stillStuck, email: 'stuck@x.com', isActive: true },
  { _id: partlyPaid, email: 'partly@x.com', isActive: true },
]);
for (const u of [parent, rishabh, steady, stillStuck, partlyPaid]) await Balance.create({ user: String(u), BTC_DEPOSIT: 0 });
const R = String(rishabh), S = String(steady), X = String(stillStuck), P = String(partlyPaid);

console.log('\n--- snapshot records sessions that are stuck right now ---');
await mkMining(R, { mining_isactive: true, start_time: 1789307714440, local_start_time: null, hashpower: 805, streakDays: 2, streakLastDate: '2026-09-20' });
await mkMining(X, { mining_isactive: true, start_time: 1789307714440, local_start_time: null, hashpower: 100 });
await mkMining(S, { mining_isactive: true, start_time: Date.now(), local_start_time: '21/09/2026, 10:00:00 AM', hashpower: 50 });
let snap = await C.snapshotStuckSessions();
check('two stuck sessions recorded; the healthy one is not', snap.stuck === 2 && snap.recorded === 2, JSON.stringify(snap));
snap = await C.snapshotStuckSessions();
check('snapshot again records nothing new', snap.recorded === 0);
const recR = await Recovery.findOne({ user: R }).lean();
check('hashpower and stuck day captured', recR.hashpower === 805 && recR.sessionDay === '2026-09-13');

// The fixed settlement runs later and resets Rishabh (but not the still-stuck user).
await Recovery.updateOne({ user: R }, { $set: { capturedAt: new Date('2026-09-21T08:00:00Z') } });
await Mining.updateOne({ user: R }, { $set: { mining_isactive: false, start_time: 0, hashpower: 0, claimedHashpower: 0, lastResetTime: new Date('2026-09-21T09:30:00Z') } });

// A session the settlement itself recorded, and one with a day already paid.
await Recovery.create({ user: S, startTime: 1, sessionDay: '2026-09-15', timezone: TZ, offset: OFF, hashpower: 50, source: 'settlement', settledDay: '2026-09-19', settledAt: new Date() });
await mkMining(P, { mining_isactive: false, start_time: 0, hashpower: 0, streakDays: 9, streakLastDate: '2026-09-21' });
await Recovery.create({ user: P, startTime: 2, sessionDay: '2026-09-15', timezone: TZ, offset: OFF, hashpower: 10, source: 'settlement', settledDay: '2026-09-18', settledAt: new Date() });
await History.create({ user: P, date: new Date(Date.UTC(2026, 8, 16)), balances: { BTC: 0.5 } });

// Rishabh's real pattern: opened the app every day except 18 Sep.
const logs = [
  ...['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-19', '2026-09-20', '2026-09-21'].map(d => req(R, d)),
  ...['2026-09-16', '2026-09-17', '2026-09-18'].map(d => req(S, d)),
  ...['2026-09-16', '2026-09-17'].map(d => req(P, d)),
  req(X, '2026-09-14'),
].join('\n');
const zones = new Map((await Recovery.find({}).lean()).map(r => [r.user, { timezone: r.timezone, offset: r.offset }]));
const active = C.activeDaysFromLogText([logs], zones);
check('active days read from the logs', active.get(R).size === 9 && !active.get(R).has('2026-09-18'));

console.log('\n--- plan (dry run) ---');
const before = { r: await dep(R), parent: await dep(String(parent)), hist: await History.countDocuments() };
let plans = await C.planCompensation({ activeDays: active, logsFrom: '2026-09-12' });
const pR = plans.find(p => p.rec.user === R);
check('Rishabh: settle day taken from the reset', pR.settledDay === '2026-09-21', pR.settledDay);
check('Rishabh: pays 14,15,16,17,19,20 -- not 18 (app not opened), not 13 or 21',
  JSON.stringify(pR.pay.map(x => x.day)) === JSON.stringify(['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-19', '2026-09-20']), JSON.stringify(pR.pay.map(x => x.day)));
check('Rishabh: 805 GH/s x rate x 24h per day', Math.abs(pR.pay[0].btc - PER_DAY) < 1e-18 && Math.abs(PER_DAY - 4.8686e-7) < 1e-10, `${pR.pay[0].btc}`);
check('Rishabh: streak 2 -> 3 (19, 20, 21; 18 breaks it)', pR.streak.before === 2 && pR.streak.after === 3 && pR.streak.afterLast === '2026-09-21', JSON.stringify(pR.streak));
const pX = plans.find(p => p.rec.user === X);
check('still-stuck session: nothing planned', !pX.settledDay && pX.pay.length === 0 && /still stuck/.test(pX.note));
const pS = plans.find(p => p.rec.user === S);
check('settlement-recorded session: pays 16,17,18 (active days between 15 and 19)', JSON.stringify(pS.pay.map(x => x.day)) === '["2026-09-16","2026-09-17","2026-09-18"]', JSON.stringify(pS.pay.map(x => x.day)));
check('dry run wrote nothing', (await dep(R)) === before.r && (await History.countDocuments()) === before.hist);
const early = await C.planCompensation({ activeDays: active, logsFrom: '2026-09-16' });
check('days before the oldest log are not paid', early.find(p => p.rec.user === R).pay[0].day === '2026-09-16');

console.log('\n--- apply ---');
let results = await C.applyCompensation(plans);
const rR = results.find(r => r.user === R);
check('Rishabh paid 6 days', rR.paidDays.length === 6 && rR.errors.length === 0, JSON.stringify(rR));
check('balance increased by exactly 6 days', Math.abs((await dep(R)) - 6 * PER_DAY) < 1e-15, `${await dep(R)}`);
check('one history row per paid day', (await History.countDocuments({ user: R })) === 6);
check('referrer got 5% of each day', Math.abs((await dep(String(parent))) - 0.05 * 6 * PER_DAY) < 1e-15 && (await Referral.countDocuments({ childUserId: R })) === 6, `${await dep(String(parent))}`);
const mR = await Mining.findOne({ user: R }).lean();
check('streak raised to 3, last day 21 Sep', mR.streakDays === 3 && mR.streakLastDate === '2026-09-21');
const rP = results.find(r => r.user === P);
check('a day that already had history is not paid again', rP.alreadyPaid.includes('2026-09-16') && rP.paidDays.includes('2026-09-17') && !rP.paidDays.includes('2026-09-16'), JSON.stringify(rP));
check('streak never lowered (9 stays 9)', (await Mining.findOne({ user: P }).lean()).streakDays === 9);
check('still-stuck user untouched', (await dep(X)) === 0);
check('recovery record notes what was paid', (await Recovery.findOne({ user: R }).lean()).compensatedDays.length === 6);

console.log('\n--- re-running pays nothing ---');
const snapshot = { r: await dep(R), parent: await dep(String(parent)), hist: await History.countDocuments() };
plans = await C.planCompensation({ activeDays: active, logsFrom: '2026-09-12' });
results = await C.applyCompensation(plans);
check('second run: no new days paid', results.every(r => r.paidDays.length === 0));
check('balances and history unchanged', (await dep(R)) === snapshot.r && (await dep(String(parent))) === snapshot.parent && (await History.countDocuments()) === snapshot.hist);

console.log('\n--- sessions already reset before any record: recovered from the settlement log ---');
const logged = oid(), noHistory = oid(), notReset = oid();
await users.insertMany([{ _id: logged, email: 'logged@x.com', isActive: true }, { _id: noHistory, email: 'nohist@x.com', isActive: true }, { _id: notReset, email: 'notreset@x.com', isActive: true }]);
const L = String(logged), N = String(noHistory), NR = String(notReset);
for (const u of [L, N]) { await Balance.create({ user: u, BTC_DEPOSIT: 0 }); await mkMining(u, { mining_isactive: false, start_time: 0, hashpower: 0 }); }
// L mined normally on 10-12 Sep (one zero day ignored), then got stuck on the 13th.
await History.insertMany([
  { user: L, date: new Date(Date.UTC(2026, 8, 10)), balances: { BTC: 3e-7 } },
  { user: L, date: new Date(Date.UTC(2026, 8, 11)), balances: { BTC: 5e-7 } },
  { user: L, date: new Date(Date.UTC(2026, 8, 12)), balances: { BTC: 0 } },
  { user: L, date: new Date(Date.UTC(2026, 8, 1)), balances: { BTC: 9e-6 } }, // older than 7 days: ignored
]);
const settlementLog = [
  `User ${L}: session has no local_start_time; using start_time's local day 2026-09-13`,
  `User ${NR}: session has no local_start_time; using start_time's local day 2026-09-21`,
  `User ${L}: session has no local_start_time; using start_time's local day 2026-09-13`,
  `Reset user ${L}: claimed=0, purchased=0, total=0, resetTime=2026-09-21T10:00:00.000Z, userDate=2026-09-21`,
  `User ${N}: session has no local_start_time; using start_time's local day 2026-09-14`,
  `Reset user ${N}: claimed=0, purchased=0, total=0, resetTime=2026-09-21T10:00:00.000Z, userDate=2026-09-21`,
].join('\n');
let fromLog = await C.recordFromSettlementLog(settlementLog);
check('two reset sessions found; one never reset is not', fromLog.found === 2 && fromLog.recorded === 2, JSON.stringify(fromLog));
fromLog = await C.recordFromSettlementLog(settlementLog);
check('reading the log again records nothing new', fromLog.recorded === 0);
const recL = await Recovery.findOne({ user: L }).lean();
check("basis = own average of days with mining in the 7 days before (3e-7, 5e-7)", Math.abs(recL.dailyBtc - 4e-7) < 1e-18 && recL.basisDays === 2, JSON.stringify(recL));
const logActive = C.activeDaysFromLogText([['2026-09-14', '2026-09-15', '2026-09-20'].map(d => req(L, d)).join('\n') + '\n' + req(N, '2026-09-16')], new Map([[L, { timezone: TZ, offset: OFF }], [N, { timezone: TZ, offset: OFF }]]));
const logPlans = (await C.planCompensation({ activeDays: logActive, logsFrom: '2026-09-12' })).filter(p => [L, N].includes(p.rec.user));
const pL = logPlans.find(p => p.rec.user === L);
check('log user paid their average for each active missed day', JSON.stringify(pL.pay.map(x => x.day)) === '["2026-09-14","2026-09-15","2026-09-20"]' && pL.pay.every(x => Math.abs(x.btc - 4e-7) < 1e-18), JSON.stringify(pL.pay));
const pN = logPlans.find(p => p.rec.user === N);
check('no earlier history: nothing paid, reason shown', pN.pay.length === 0 && pN.skipped.some(x => /no mining history/.test(x)), JSON.stringify(pN.skipped));
const beforeL = await dep(L);
await C.applyCompensation(logPlans);
check('log user balance up by 3 x average', Math.abs((await dep(L)) - beforeL - 3 * 4e-7) < 1e-15, `${await dep(L)}`);

console.log('\n--- review fixes from the first real dry run ---');
// koreateamos0: stuck only on 20 Sep but opened the app daily since 7 Sep.
const korea = oid(), fresh = oid(), known = oid();
await users.insertMany([{ _id: korea, email: 'korea@x.com', isActive: true }, { _id: fresh, email: 'fresh@x.com', isActive: true }, { _id: known, email: 'known@x.com', isActive: true }]);
const K = String(korea), F = String(fresh), KN = String(known);
for (const u of [K, F, KN]) await Balance.create({ user: u, BTC_DEPOSIT: 0 });
await mkMining(K, { mining_isactive: false, start_time: 0, streakDays: 2, streakLastDate: '2026-09-21' });
await mkMining(F, { mining_isactive: false, start_time: 0, streakDays: 1, streakLastDate: '2026-09-09' });
await mkMining(KN, { mining_isactive: false, start_time: 0 });
await Recovery.create({ user: K, startTime: -11, sessionDay: '2026-09-20', timezone: TZ, offset: OFF, hashpower: 0, dailyBtc: 2e-7, basisDays: 7, source: 'log', settledDay: '2026-09-21', settledAt: new Date() });
// A newer account with no history before getting stuck -- only the stuck day's own credit.
await Recovery.create({ user: F, startTime: -12, sessionDay: '2026-09-09', timezone: TZ, offset: OFF, hashpower: 0, dailyBtc: null, basisDays: 0, source: 'log', settledDay: '2026-09-21', settledAt: new Date() });
await History.create({ user: F, date: new Date(Date.UTC(2026, 8, 9)), balances: { BTC: 1e-7 } });
await Recovery.create({ user: KN, startTime: -13, sessionDay: '2026-09-13', timezone: TZ, offset: OFF, hashpower: 0, dailyBtc: 4.53e-8, basisDays: 7, source: 'log', settledDay: '2026-09-21', settledAt: new Date() });
const days = (from, to) => { const out = []; for (let d = from; d <= to; d = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8) + 1)).toISOString().slice(0, 10)) out.push(d); return out; };
const reviewLogs = [...days('2026-09-07', '2026-09-21').map(d => req(K, d)), ...days('2026-09-10', '2026-09-12').map(d => req(F, d)), ...['2026-09-14', '2026-09-15'].map(d => req(KN, d))].join('\n');
const reviewActive = C.activeDaysFromLogText([reviewLogs], new Map([K, F, KN].map(u => [u, { timezone: TZ, offset: OFF }])));
let review = (await C.planCompensation({ activeDays: reviewActive, logsFrom: '2026-09-07' }));
const pK = review.find(p => p.rec.user === K);
check('streak counts only stuck days: 1-day stuck user stays 2 (was 2 -> 15)', pK.streak.after === 2, JSON.stringify(pK.streak));
const pF = review.find(p => p.rec.user === F);
check('no earlier history: paid at the stuck day\'s own credit', pF.pay.length === 3 && pF.pay.every(x => Math.abs(x.btc - 1e-7) < 1e-18) && /stuck-day credit/.test(pF.basis), JSON.stringify({ pay: pF.pay, basis: pF.basis }));
check('its streak is raised only across stuck days (1 -> 3: 10, 11, 12 Sep)', pF.streak.after === 3 && pF.streak.afterLast === '2026-09-12', JSON.stringify(pF.streak));
check('stuck day itself is the latest active day: counts as 1', (await C.planCompensation({ activeDays: new Map([[K, new Set(['2026-09-20'])]]), logsFrom: '2026-09-07' })).find(p => p.rec.user === K).streak.after === 2);
const n = await C.setKnownHashpower(KN, 805);
review = await C.planCompensation({ activeDays: reviewActive, logsFrom: '2026-09-07' });
const pKN = review.find(p => p.rec.user === KN);
check('known hashpower (805 GH/s) replaces the lower average', n === 1 && pKN.basis === '805 GH/s' && Math.abs(pKN.pay[0].btc - PER_DAY) < 1e-18, JSON.stringify({ n, basis: pKN.basis, btc: pKN.pay[0]?.btc }));
check('cannot change the basis of a session already paid', (await C.setKnownHashpower(L, 999)) === 0);

console.log('\n--- the settlement records a stuck session before resetting it ---');
const cron = fs.readFileSync(new URL('../cronJobs.js', import.meta.url), 'utf8');
const recordAt = cron.indexOf('StuckSessionRecovery.updateOne');
const resetAt = cron.indexOf('claimedHashpower: 0,');
check('recorded before the reset wipes hashpower', recordAt > 0 && resetAt > recordAt);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await mongoose.disconnect(); await mongod.stop(); process.exit(fail ? 1 : 0);
