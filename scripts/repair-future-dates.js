/**
 * Unfreeze mining records stuck on a date in the future.
 *
 * Before helpers/clientTime.js (2026-10-21) the server stored whatever date
 * the app sent. 67 real users ended up with a streak date in 2027-2028
 * (pattern "YYYY-MM-02", most likely an old app version's date format), so
 * every real day counted as "earlier" and their streak could never grow; one
 * session had a 2037 start and could never settle.
 *
 * For each record with a day field beyond what is "today" anywhere on Earth:
 *  - streakLastDate / startRewardDay / adCountDay / gameGhDay /
 *    privilegeAdsDay -> null (the streak days already earned are kept; the
 *    next real day continues from there; daily counters restart normally);
 *  - a session whose local_start_time reads as a future day is settled
 *    and ended. These were mostly honest phones writing dates in US order
 *    ("1/11/2026" = 11 Jan, read as 1 Nov) or the Thai calendar ("2569
 *    BE"): never settled, stuck since Jan-Feb 2026. The day is paid from
 *    the real start_time the server recorded, exactly as the nightly
 *    settlement pays (settlementAmount, capped at that local midnight and
 *    the daily ceiling), unless a mining day is already recorded for it.
 *    Without a usable start_time the session is ended unpaid.
 * Everything changed is written to a JSON backup first.
 *
 * Usage (backend dir, as the app user):
 *   node scripts/repair-future-dates.js            # dry run
 *   node scripts/repair-future-dates.js --apply
 */
import '../config/loadEnv.js';
import fs from 'fs';
import mongoose from 'mongoose';
import { plausibleDayRange, dayFromLocalTime, isPlausibleOffset, isValidTimeZone } from '../helpers/clientTime.js';
import { settlementAmount, getLocalDateStrAt, getHistoryDateFromSessionStartStr } from '../helpers/miningDaySettlement.js';
import Balance from '../models/Balance.js';
import BalanceHistory from '../models/BalanceHistory.js';
import UserMining from '../models/UserMiningDetails.js';

const APPLY = process.argv.includes('--apply');
const DAY_FIELDS = ['streakLastDate', 'startRewardDay', 'adCountDay', 'gameGhDay', 'privilegeAdsDay'];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.db.collection('userminings');
  const { max } = plausibleDayRange();

  const dayRows = await col.find({ $or: DAY_FIELDS.map(f => ({ [f]: { $gt: max } })) }).toArray();
  const sessionRows = (await col.find({ local_start_time: { $type: 'string' } }, { projection: { user: 1, local_start_time: 1, mining_isactive: 1, start_time: 1 } }).toArray())
    .filter(r => (dayFromLocalTime(r.local_start_time) || '') > max);

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} (latest real day anywhere: ${max})`);
  console.log(`records with a future day field: ${dayRows.length}`);
  console.log(`sessions with a future start: ${sessionRows.length}`);

  if (APPLY && (dayRows.length || sessionRows.length)) {
    const file = `/home/pi/backups/future-dates-${new Date().toISOString().slice(0, 10)}.json`;
    fs.mkdirSync('/home/pi/backups', { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ dayRows, sessionRows }, null, 1));
    console.log(`backup: ${file}`);
  }

  let fixedDays = 0, endedSessions = 0;
  for (const r of dayRows) {
    const set = {};
    for (const f of DAY_FIELDS) if (typeof r[f] === 'string' && r[f] > max) set[f] = null;
    console.log(`  ${r.user}: ${Object.keys(set).map(f => `${f} ${r[f]} -> null`).join(', ')} (streak days kept: ${r.streakDays ?? 0})`);
    if (APPLY) { await col.updateOne({ _id: r._id }, { $set: set }); fixedDays++; }
  }
  let paidBtc = 0;
  for (const r of sessionRows) {
    // Full document (with methods) so the amount is computed exactly as the cron does.
    const doc = await UserMining.findById(r._id);
    const startMs = Number(doc?.start_time) || 0;
    const tz = isValidTimeZone(doc?.timezone) ? doc.timezone : null;
    const off = isPlausibleOffset(doc?.offset) ? Number(doc.offset) : 0;
    let note = 'ended, not paid (no real start time)';
    let pay = 0, histDate = null;
    if (startMs > 0 && startMs < Date.now()) {
      const day = getLocalDateStrAt(startMs, tz, off);
      histDate = getHistoryDateFromSessionStartStr(day);
      const already = await BalanceHistory.exists({ user: String(doc.user), date: histDate });
      if (already) {
        note = `ended; ${day} already has a mining day recorded`;
      } else {
        pay = settlementAmount({ miningDetail: doc, userTz: tz, userOffset: off }).minedBtc;
        note = `pay ${pay.toExponential(3)} BTC for ${day} (${doc.hashpower || 0} GH/s), then end`;
      }
    }
    console.log(`  ${r.user}: session started "${r.local_start_time}" -> ${note}`);
    if (!APPLY) { paidBtc += pay; continue; }
    if (pay > 0) {
      const amount = mongoose.Types.Decimal128.fromString(pay.toFixed(16));
      await Balance.updateOne({ user: String(doc.user) }, { $inc: { BTC_DEPOSIT: amount } });
      await BalanceHistory.create({ user: String(doc.user), date: histDate, balances: { BTC: amount } });
      paidBtc += pay;
    }
    await col.updateOne({ _id: r._id }, {
      $set: {
        mining_isactive: false, local_start_time: null, local_stop_time: null, start_time: 0, stop_time: 0,
        claimedHashpower: 0, hashpower: Number(doc.purchasedHashpower) || 0, lastResetTime: new Date(),
      },
    });
    endedSessions++;
  }
  console.log(APPLY
    ? `fixed ${fixedDays} records, settled and ended ${endedSessions} sessions, paid ${paidBtc.toFixed(10)} BTC`
    : `would pay ${paidBtc.toFixed(10)} BTC in total; nothing written (add --apply)`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
