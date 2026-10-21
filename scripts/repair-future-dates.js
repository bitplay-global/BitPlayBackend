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
 *  - an active session whose local_start_time is in the future is ended
 *    without a payout (its start date was not real).
 * Everything changed is written to a JSON backup first.
 *
 * Usage (backend dir, as the app user):
 *   node scripts/repair-future-dates.js            # dry run
 *   node scripts/repair-future-dates.js --apply
 */
import '../config/loadEnv.js';
import fs from 'fs';
import mongoose from 'mongoose';
import { plausibleDayRange, dayFromLocalTime } from '../helpers/clientTime.js';

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
  for (const r of sessionRows) {
    console.log(`  ${r.user}: session started "${r.local_start_time}" -> ended, not paid`);
    if (APPLY) {
      await col.updateOne({ _id: r._id }, { $set: { mining_isactive: false, local_start_time: null, start_time: 0, stop_time: 0, claimedHashpower: 0 } });
      endedSessions++;
    }
  }
  console.log(APPLY ? `fixed ${fixedDays} records, ended ${endedSessions} sessions` : 'nothing written (add --apply)');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
