#!/usr/bin/env node
/**
 * Read-only production health check for the five core flows: mining payouts,
 * daily streak, referral rewards, plan purchases and rewarded ads.
 *
 * Changes nothing. Prints counts and a few sample ids per finding, never
 * emails, keys or tokens. Run on the server from the backend directory:
 *
 *   node scripts/production-health-check.js            # last 14 days
 *   node scripts/production-health-check.js --days 30
 */
import '../config/loadEnv.js';
import mongoose from 'mongoose';

const argv = process.argv.slice(2);
const DAYS = argv.includes('--days') ? Number(argv[argv.indexOf('--days') + 1]) : 14;
if (!Number.isFinite(DAYS) || DAYS < 1) { console.error('--days must be a positive number'); process.exit(2); }
const SINCE = new Date(Date.now() - DAYS * 864e5);

const num = v => (v == null ? 0 : Number(v.toString?.() ?? v));
const ids = (arr, n = 5) => arr.slice(0, n).map(String).join(', ') + (arr.length > n ? ` … (+${arr.length - n})` : '');
const line = (label, value, note = '') => console.log(`  ${label.padEnd(58)} ${String(value).padStart(8)}${note ? '   ' + note : ''}`);
const head = t => console.log(`\n=== ${t} ===`);
const findings = [];
const flag = (area, msg) => findings.push(`${area}: ${msg}`);

// Local calendar day for an offset in minutes (client getTimezoneOffset).
const localDay = (offset, now = Date.now()) => {
  const off = Number.isFinite(Number(offset)) ? Number(offset) : 0;
  return new Date(now - off * 60000).toISOString().slice(0, 10);
};
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5);

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection;
const C = n => db.collection(n);
console.log(`BitPlay production health check   window: last ${DAYS} days (since ${SINCE.toISOString().slice(0, 10)})   at ${new Date().toISOString()}`);

const userIds = new Set((await C('users').find({}, { projection: { _id: 1 } }).toArray()).map(u => String(u._id)));
const minings = await C('userminings').find({}).toArray();
line('users', userIds.size);
line('mining records', minings.length);

/* ------------------------------------------------------------------ */
head('1. MINING PAYOUTS');
{
  // Same constants as the server (helpers/miningDaySettlement.js, models/UserMiningDetails.js).
  const RATE = 7e-15;                 // BTC per GH/s per second
  const SYNC_CAP = 9e-7;              // routes/api_routes/balance.js rejects larger client syncs
  const tierBonus = d => (d >= 29 ? 25 : d >= 22 ? 20 : d >= 15 ? 15 : d >= 8 ? 10 : 5);
  const effective = m => (Number(m.hashpower) || 0) * (1 - (Number(m.lossTracking?.cumulative_loss) || 0) / 100)
    + tierBonus(Number(m.streakDays) || 0) + (Number(m.stockGameBonus) || 0);

  const balances = new Map((await C('balances').find({}, { projection: { user: 1, BTC: 1 } }).toArray()).map(b => [String(b.user), num(b.BTC)]));
  const now = Date.now();
  let active = 0, behindHalf = 0, behindAny = 0, ahead = 0, stuck = 0, noSync = 0, stranded = 0;
  const behindIds = [], stuckIds = [], strandedIds = [];
  for (const m of minings) {
    const synced = balances.get(String(m.user)) || 0;
    if (!m.mining_isactive) {
      if (synced > 0) { stranded++; strandedIds.push(m.user); }
      continue;
    }
    const start = Number(m.start_time) || 0;
    if (!start) continue;
    active++;
    const elapsed = Math.min((now - start) / 1000, 24 * 3600);
    if (now - start > 26 * 3600e3) { stuck++; stuckIds.push(m.user); }
    const expected = Math.min(effective(m) * RATE * elapsed, SYNC_CAP);
    if (expected <= 0) continue;
    if (synced === 0 && elapsed > 600) noSync++;
    const ratio = synced / expected;
    if (ratio < 0.5) { behindHalf++; behindIds.push(m.user); }
    if (ratio < 0.95) behindAny++;
    if (ratio > 1.05) ahead++;
  }
  line('active mining sessions', active);
  line('  reported balance < 95% of server-expected so far', behindAny, 'app closed or backgrounded; paid the lower');
  line('  reported balance < 50% of server-expected so far', behindHalf, behindHalf ? `sample: ${ids(behindIds)}` : '');
  line('  nothing reported yet (10+ min into the session)', noSync, 'would settle at 0 if never reopened');
  line('  reported balance > 105% of server-expected', ahead, 'capped at the server value at settlement');
  line('  session older than 26h (missed settlement)', stuck, stuck ? `sample: ${ids(stuckIds)}` : '');
  line('inactive miners still holding unsettled BTC', stranded, stranded ? `sample: ${ids(strandedIds)}` : '');
  if (behindHalf) flag('mining', `${behindHalf} active session(s) are under half of what the server says they have mined; they will be under-paid.`);
  if (stuck) flag('mining', `${stuck} session(s) are past 26h without settlement.`);
  if (stranded) flag('mining', `${stranded} inactive miner(s) hold BTC that is never settled.`);

  // The 9e-7 per-sync ceiling: anyone above ~1488 GH/s loses the tail of a full day.
  const capGh = SYNC_CAP / (RATE * 86400);
  const overCap = minings.filter(m => effective(m) > capGh);
  line(`users whose power exceeds ${capGh.toFixed(0)} GH/s (sync ceiling)`, overCap.length, overCap.length ? `sample: ${ids(overCap.map(m => m.user))}` : '');
  if (overCap.length) flag('mining', `${overCap.length} user(s) mine more per day than a single sync accepts (${SYNC_CAP} BTC); they are under-paid on full days.`);

  const hist = await C('balancehistories').find({ date: { $gte: SINCE } }, { projection: { user: 1, date: 1, 'balances.BTC': 1 } }).toArray();
  const atCeiling = hist.filter(h => num(h.balances?.BTC) >= SYNC_CAP * 0.99);
  const dupKey = new Map();
  for (const h of hist) { const k = `${h.user}|${h.date.toISOString().slice(0, 10)}`; dupKey.set(k, (dupKey.get(k) || 0) + 1); }
  const dups = [...dupKey.values()].filter(n => n > 1).length;
  line('settled mining days in window', hist.length, `total ${hist.reduce((s, h) => s + num(h.balances?.BTC), 0).toExponential(4)} BTC`);
  line('  days paid at the sync ceiling (likely cut short)', atCeiling.length);
  line('  user-days settled more than once', dups);
  if (dups) flag('mining', `${dups} user-day(s) have more than one settlement row.`);

  const lossUsers = minings.filter(m => Number(m.lossTracking?.cumulative_loss) > 0);
  line('users with a mining-power loss penalty applied', lossUsers.length, lossUsers.length ? `max ${Math.max(...lossUsers.map(m => Number(m.lossTracking.cumulative_loss)))}%` : '');
  if (lossUsers.length) flag('mining', `${lossUsers.length} user(s) have a cumulative loss penalty reducing their paid hashpower.`);
}

/* ------------------------------------------------------------------ */
head('2. DAILY STREAK');
{
  let active = 0, lapsed = 0, future = 0, noDate = 0, bad = 0;
  const tiers = { '1-7': 0, '8-14': 0, '15-21': 0, '22-28': 0, '29+': 0 };
  const futureIds = [], noDateIds = [];
  for (const m of minings) {
    const days = Number(m.streakDays) || 0;
    if (days <= 0) continue;
    if (days >= 29) tiers['29+']++; else if (days >= 22) tiers['22-28']++; else if (days >= 15) tiers['15-21']++; else if (days >= 8) tiers['8-14']++; else tiers['1-7']++;
    const last = typeof m.streakLastDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.streakLastDate) ? m.streakLastDate : null;
    if (!last) { noDate++; noDateIds.push(m.user); continue; }
    const d = dayDiff(localDay(m.offset), last);
    if (d < 0) { future++; futureIds.push(m.user); }
    else if (d <= 1) active++;
    else lapsed++;
  }
  line('users with a streak (streakDays >= 1)', active + lapsed + future + noDate);
  line('  active (last counted today or yesterday, local time)', active);
  line('  lapsed (will restart at 1 on next claim)', lapsed, 'expected for inactive users');
  line('  last date in the user\'s future', future, future ? `sample: ${ids(futureIds)}` : '');
  line('  streakDays set but no valid streakLastDate', noDate, noDate ? `sample: ${ids(noDateIds)}` : '');
  console.log('  tier distribution:', JSON.stringify(tiers));
  if (future) flag('streak', `${future} record(s) have a streakLastDate ahead of the user's local day (timezone mismatch).`);
  if (noDate) flag('streak', `${noDate} record(s) have streakDays without streakLastDate; the fixed code keeps the days on next claim.`);
  void bad;
}

/* ------------------------------------------------------------------ */
head('3. REFERRAL REWARDS');
{
  const rows = await C('referralrewardhistories').find({}).toArray();
  const byStatus = rows.reduce((m, r) => (m[r.status || 'none'] = (m[r.status || 'none'] || 0) + 1, m), {});
  line('reward rows (all time)', rows.length, JSON.stringify(byStatus));
  if (byStatus.failed) flag('referral', `${byStatus.failed} reward row(s) are 'failed' and are never retried.`);

  // Each processed reward should equal 5% of the child's BalanceHistory for that day.
  const recent = rows.filter(r => r.status === 'processed' && r.rewardDate >= SINCE);
  let mismatch = 0, noHistory = 0, dupHistory = 0; const mismatchIds = [];
  for (const r of recent) {
    const h = await C('balancehistories').find({ user: String(r.childUserId), date: r.rewardDate }).toArray();
    if (!h.length) { noHistory++; continue; }
    if (h.length > 1) dupHistory++;
    const expected = num(h[0].balances?.BTC) * 0.05;
    if (Math.abs(num(r.rewardAmount) - expected) > 1e-12) { mismatch++; mismatchIds.push(r._id); }
  }
  line(`processed rewards in window`, recent.length);
  line('  amount != 5% of child\'s mined BTC that day', mismatch, mismatch ? `sample: ${ids(mismatchIds)}` : '');
  line('  child has no BalanceHistory row for that day', noHistory);
  line('  child has duplicate BalanceHistory rows that day', dupHistory);
  if (mismatch) flag('referral', `${mismatch} reward(s) are not exactly 5% of the child's mining.`);
  if (dupHistory) flag('mining', `${dupHistory} child-day(s) have more than one BalanceHistory row (possible double settlement).`);

  // Referred children who mined in the window but whose parent got nothing for that day.
  const referred = await C('users').find({ referralUsed: { $nin: [null, 'null', ''] } }, { projection: { _id: 1, referralUsed: 1, referralCode: 1 } }).toArray();
  const codes = new Map((await C('users').find({ referralCode: { $nin: [null, ''] } }, { projection: { _id: 1, referralCode: 1, referralUsed: 1, isActive: 1 } }).toArray())
    .map(u => [String(u.referralCode).toUpperCase(), u]));
  let orphanCodes = 0, mutual = 0, missed = 0; const missedIds = [];
  for (const c of referred) {
    const parent = codes.get(String(c.referralUsed).toUpperCase());
    if (!parent) { orphanCodes++; continue; }
    if (String(parent.referralUsed || '').toUpperCase() === String(c.referralCode || '').toUpperCase() && c.referralCode) mutual++;
    const mined = await C('balancehistories').find({ user: String(c._id), date: { $gte: SINCE } }).toArray();
    for (const h of mined) {
      if (num(h.balances?.BTC) <= 0) continue;
      const paid = await C('referralrewardhistories').findOne({ childUserId: String(c._id), rewardDate: h.date, status: 'processed' });
      if (!paid) { missed++; missedIds.push(`${c._id}@${h.date.toISOString().slice(0, 10)}`); }
    }
  }
  line('users who used a referral code', referred.length);
  line('  code matches no current user', orphanCodes, 'referrer deleted, or typo at signup');
  line('  mutual referrals (A referred B and B referred A)', mutual);
  line('  child-days mined in window with no processed parent reward', missed, missed ? `sample: ${ids(missedIds)}` : '');
  if (missed) flag('referral', `${missed} referred child-day(s) mined without the referrer being paid.`);
  if (mutual) flag('referral', `${mutual} mutual referral pair(s).`);
}

/* ------------------------------------------------------------------ */
head('4. PLAN PURCHASES');
{
  const purchases = await C('purchases').find({ createdAt: { $gte: SINCE } }).toArray();
  const all = await C('purchases').find({}).project({ user: 1, revenuecat_customer_id: 1, status: 1 }).toArray();
  const byStatus = purchases.reduce((m, p) => (m[p.status || 'none'] = (m[p.status || 'none'] || 0) + 1, m), {});
  line(`plan purchases in window`, purchases.length, JSON.stringify(byStatus));
  const unverified = purchases.filter(p => !p.store_transaction_id);
  const dummy = purchases.filter(p => !p.revenuecat_customer_id || p.revenuecat_customer_id === 'dummy');
  line('  without a store transaction id', unverified.length, unverified.length ? `sample: ${ids(unverified.map(p => p._id))}` : '');
  line("  with no / 'dummy' RevenueCat customer id", dummy.length);
  if (unverified.length) flag('purchases', `${unverified.length} recent purchase(s) have no store transaction id.`);

  // Buyers whose mining record doesn't reflect any purchased power.
  const buyerIds = [...new Set(all.filter(p => (p.status || 'completed') === 'completed').map(p => String(p.user)))];
  const byUser = new Map(minings.map(m => [String(m.user), m]));
  const noPower = buyerIds.filter(u => !(Number(byUser.get(u)?.purchasedHashpower) > 0));
  line('buyers (all time, completed)', buyerIds.length);
  line('  buyer whose purchasedHashpower is 0 or missing', noPower.length, noPower.length ? `sample: ${ids(noPower)}` : '');
  if (noPower.length) flag('purchases', `${noPower.length} buyer(s) have no purchased hashpower on their mining record.`);

  // One RevenueCat customer feeding several BitPlay users.
  const rc = new Map();
  for (const p of all) { if (!p.revenuecat_customer_id || p.revenuecat_customer_id === 'dummy') continue; const s = rc.get(p.revenuecat_customer_id) || new Set(); s.add(String(p.user)); rc.set(p.revenuecat_customer_id, s); }
  const shared = [...rc.entries()].filter(([, s]) => s.size > 1);
  line('  RevenueCat customer shared by several users', shared.length, 'shared device or reinstall (users are never logged in to RevenueCat)');
  if (shared.length) flag('purchases', `${shared.length} RevenueCat customer id(s) are attached to more than one user.`);

  const priv = await C('admultiplierprivileges').find({ createdAt: { $gte: SINCE } }).toArray();
  const privActive = await C('admultiplierprivileges').countDocuments({ status: 'active', expires_at: { $gt: new Date() } });
  const privExpiredActive = await C('admultiplierprivileges').countDocuments({ status: 'active', expires_at: { $lte: new Date() } });
  line('super-privilege purchases in window', priv.length, `active now: ${privActive}`);
  line('  marked active but already expired', privExpiredActive);
  if (privExpiredActive) flag('purchases', `${privExpiredActive} privilege(s) still marked active after expiry.`);
}

/* ------------------------------------------------------------------ */
head('5. REWARDED ADS (today, per user local day)');
{
  const now = Date.now();
  let capped60 = 0, capped30 = 0, stale = 0, watchers = 0, total = 0;
  const staleIds = [];
  for (const m of minings) {
    const r = Number(m.rewarded_ads_watched) || 0, t = Number(m.thirty_gh_rewarded_ads_watched) || 0;
    total += r + t;
    if (r + t > 0) watchers++;
    if (r >= 60) capped60++;
    if (t >= 30) capped30++;
    // Counters are reset by the day-rollover settlement. An active miner whose
    // last reset is older than ~36h is stuck with yesterday's counters.
    const last = m.lastResetTime ? new Date(m.lastResetTime).getTime() : null;
    if (m.mining_isactive && last && now - last > 36 * 3600e3) { stale++; staleIds.push(m.user); }
  }
  line('users who watched rewarded ads today', watchers);
  line('  total rewarded ads counted today', total);
  line('  at the daily cap of 60 (regular)', capped60, 'their button shows "Claimed (60)"');
  line('  at the daily cap of 30 (Super Ad Miner)', capped30);
  line('  active miners whose counters were not reset for 36h+', stale, stale ? `sample: ${ids(staleIds)}` : '');
  if (stale) flag('ads', `${stale} active miner(s) have counters older than 36h; they may be stuck at the cap.`);

  const cfg = await C('googleads').find({ production: true }).toArray();
  const sample = cfg.filter(a => /3940256099942544|^\/6499\//.test(a.ad_id) || !/^(ca-app-pub-|\/)/.test(a.ad_id));
  line('production ad config entries', cfg.length);
  line('  sample or invalid unit ids in production config', sample.length, sample.map(a => `${a.platform}/${a.ad_type}`).join(', '));
  if (sample.length) flag('ads', `${sample.length} production ad config entr(ies) hold sample or invalid ids (${sample.map(a => `${a.platform}/${a.ad_type}`).join(', ')}).`);
}

/* ------------------------------------------------------------------ */
head('SUMMARY');
if (!findings.length) console.log('  No problems found.');
for (const f of findings) console.log('  - ' + f);
await mongoose.disconnect();
