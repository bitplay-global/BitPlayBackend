#!/usr/bin/env node
/**
 * Read-only report on Super Privileges holders: what they paid, how much they
 * have actually mined since buying, how hard they work the ad tracks, and what
 * that pace projects to over the privilege's one-year life.
 *
 *   node scripts/privilege-holders-report.js
 *
 * Why: the plans multiply the Super Ad Miner reward (x51 / x101), so a holder
 * who watches every ad every day can mine more than the plan costs. This shows
 * whether real holders come anywhere near that.
 *
 * Changes nothing. Prints per-holder lines and a summary.
 */
import '../config/loadEnv.js';
import mongoose from 'mongoose';

const BTC_PER_GH_PER_DAY = 0.000000000000007 * 86400;
const PER_CLAIM = 5.5;                 // BASE_HASHPOWER_PER_AD
const SUPER_CLAIMS = 30;               // MAX_SUPER_AD_MINER_CLAIMS_PER_DAY
const FREE_ADS = 60 * PER_CLAIM;       // MAX_REWARDED_ADS_PER_TRACK
const PRIVILEGE_ADS = { 50: 50 * 10, 100: 50 * 20 };  // screen allowance: ads x flat Gh
const DAY = 86400000;
const btc = n => n.toFixed(8);

/** Gh/s a holder of this multiplier reaches in a day if they watch everything. */
function maxDailyGh(boost) {
  return SUPER_CLAIMS * PER_CLAIM * (1 + boost) + (PRIVILEGE_ADS[boost] || 0) + FREE_ADS + 50;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set (.env next to server.js).');
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const now = new Date();

  const privileges = await db.collection('admultiplierprivileges')
    .find({ status: 'completed' }).sort({ purchase_date: 1 }).toArray();
  if (!privileges.length) { console.log('\nNo Super Privileges purchases found.\n'); return; }

  // One row per holder: tiers stack, so sum their multipliers.
  const holders = new Map();
  for (const p of privileges) {
    const id = String(p.user);
    if (!holders.has(id)) holders.set(id, { id, tiers: [], boost: 0, paid: 0, first: p.purchase_date, expires: p.expires_at, active: false });
    const h = holders.get(id);
    h.tiers.push(p.tier);
    h.paid += Number(p.price_paid) || 0;
    if (new Date(p.expires_at) > now) { h.boost += Number(p.multiplier) || 0; h.active = true; }
    if (new Date(p.expires_at) > new Date(h.expires)) h.expires = p.expires_at;
    if (new Date(p.purchase_date) < new Date(h.first)) h.first = p.purchase_date;
  }

  const ids = [...holders.keys()];
  for (const u of await db.collection('users')
    .find({ _id: { $in: ids.map(i => new mongoose.Types.ObjectId(i)) } }, { projection: { email: 1 } }).toArray()) {
    holders.get(String(u._id)).email = u.email;
  }
  for (const m of await db.collection('userminings').find({ user: { $in: ids } }).toArray()) {
    const h = holders.get(String(m.user));
    if (h) { h.mining = m; }
  }

  console.log(`\n${holders.size} Super Privileges holder(s). Rate: ${BTC_PER_GH_PER_DAY.toExponential(4)} BTC per GH/s per day.\n`);
  let totalPaid = 0, totalMined = 0, totalProjected = 0, totalWithdrawn = 0;

  for (const h of [...holders.values()].sort((a, b) => new Date(a.first) - new Date(b.first))) {
    const since = new Date(h.first);
    const daysHeld = Math.max(1, Math.round((now - since) / DAY));
    const rows = await db.collection('balancehistories').find({ user: h.id, date: { $gte: since } }).toArray();
    const mined = rows.reduce((s, r) => s + parseFloat(r.balances?.BTC?.toString() || '0'), 0);
    const minedDays = rows.filter(r => parseFloat(r.balances?.BTC?.toString() || '0') > 0).length;
    const perDay = mined / daysHeld;
    const maxGh = maxDailyGh(h.boost);
    const maxPerDay = maxGh * BTC_PER_GH_PER_DAY;
    const effort = maxPerDay > 0 ? (perDay / maxPerDay) * 100 : 0;
    const projectedYear = perDay * 365;
    const withdrawals = await db.collection('withdrawals')
      .find({ userId: h.id, status: { $in: ['completed', 'approved', 'paid', 'success'] } }).toArray();
    const withdrawn = withdrawals.reduce((s, w) => s + (Number(w.amountNumeric) || 0), 0);
    const balance = await db.collection('balances').findOne({ user: h.id });
    const held = parseFloat(balance?.BTC_DEPOSIT?.toString() || '0');

    totalPaid += h.paid; totalMined += mined; totalProjected += projectedYear; totalWithdrawn += withdrawn;

    console.log(`  ${h.email || h.id}`);
    console.log(`     tiers ${h.tiers.join(' + ')} (x${1 + h.boost})  paid ${h.paid ? `${h.paid.toFixed(2)}` : 'n/a'}  bought ${new Date(h.first).toISOString().slice(0, 10)}  ${h.active ? `active until ${new Date(h.expires).toISOString().slice(0, 10)}` : 'EXPIRED'}`);
    console.log(`     mined since buying: ${btc(mined)} BTC over ${daysHeld} day(s) (${minedDays} day(s) with mining) = ${btc(perDay)}/day`);
    console.log(`     ad effort: ${effort.toFixed(1)}% of the ${Math.round(maxGh)} GH/s/day maximum  ->  projects to ${btc(projectedYear)} BTC/year`);
    console.log(`     balance now ${btc(held)} BTC, withdrawn ${btc(withdrawn)} BTC in ${withdrawals.length} withdrawal(s)`);
    if (h.mining) {
      console.log(`     today so far: ${h.mining.thirty_gh_rewarded_ads_watched || 0}/30 super-ad claims, ${h.mining.rewarded_ads_watched || 0}/60 free ads, hashpower ${Math.round(h.mining.hashpower || 0)} GH/s`);
    } else {
      console.log('     no mining record');
    }
  }

  console.log(`\nTotals: paid ${totalPaid.toFixed(2)} | mined since buying ${btc(totalMined)} BTC | withdrawn ${btc(totalWithdrawn)} BTC`);
  console.log(`At their current pace these holders would mine ${btc(totalProjected)} BTC over a year.`);
  console.log('Ad effort is what matters: 100% means watching every ad every day, which is where a plan can pay out more than it cost.\n');
}

main()
  .catch(err => { console.error(`\nError: ${err.message}`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
