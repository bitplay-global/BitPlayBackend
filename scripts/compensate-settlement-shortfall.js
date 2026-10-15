/**
 * Pay back what the old settlement rule withheld.
 *
 * Until 2026-10-15 the hourly settlement credited min(app-reported BTC,
 * server-computed BTC) for each mining day. Each such settlement was logged
 * by the cron as
 *
 *   User <id> (tz=...): sessionDay=YYYY-MM-DD, today=..., synced=S, fromElapsed=F, mined(min)=M
 *
 * The shortfall for that day is min(F, daily ceiling) - M. This script reads
 * those lines from the pm2 log, credits each user's BTC_DEPOSIT with the
 * shortfall and adds it to that day's BalanceHistory row, exactly as the
 * settlement would have. Each (user, day) is recorded in the
 * `settlementcompensations` collection first, so running the script again
 * (or on an overlapping log) never pays a day twice. Lines in the new format
 * (`mined=`) were paid in full and are ignored.
 *
 * Referral rewards (5% to a referrer) are NOT recomputed for the shortfall.
 *
 * Usage (from the backend directory, as the app user):
 *   node scripts/compensate-settlement-shortfall.js                 # dry run, default log
 *   node scripts/compensate-settlement-shortfall.js --apply         # credit
 *   node scripts/compensate-settlement-shortfall.js --log /path/to/admin-panel-out.log --user <id> --apply
 */
import '../config/loadEnv.js';
import fs from 'fs';
import readline from 'readline';
import mongoose from 'mongoose';
import Balance from '../models/Balance.js';
import BalanceHistory from '../models/BalanceHistory.js';
import { maxSettlementBtcPerDay, getHistoryDateFromSessionStartStr } from '../helpers/miningDaySettlement.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const APPLY = args.includes('--apply');
const LOG = flag('--log') || '/home/pi/.pm2/logs/admin-panel-out.log';
const ONLY_USER = flag('--user');
const MIN_SHORTFALL = 1e-12;

const LINE = /User ([0-9a-f]{24}) \(tz=[^)]*\): sessionDay=(\d{4}-\d{2}-\d{2}), today=\S+, synced=([0-9.eE+-]+), fromElapsed=([0-9.eE+-]+), mined\(min\)=([0-9.eE+-]+)/;

async function readShortfalls() {
  const byKey = new Map(); // "user|day" -> { user, day, fromElapsed, paid, shortfall }
  const cap = maxSettlementBtcPerDay();
  const rl = readline.createInterface({ input: fs.createReadStream(LOG) });
  for await (const line of rl) {
    const m = LINE.exec(line);
    if (!m) continue;
    const [, user, day, , fromElapsedRaw, paidRaw] = m;
    if (ONLY_USER && user !== ONLY_USER) continue;
    const fromElapsed = Math.min(Number(fromElapsedRaw) || 0, cap);
    const paid = Number(paidRaw) || 0;
    const shortfall = fromElapsed - paid;
    if (!(shortfall > MIN_SHORTFALL)) continue;
    // A day can be logged twice (restart mid-settlement); keep the larger.
    const key = `${user}|${day}`;
    const prev = byKey.get(key);
    if (!prev || shortfall > prev.shortfall) byKey.set(key, { user, day, fromElapsed, paid, shortfall });
  }
  return [...byKey.values()];
}

async function main() {
  if (!fs.existsSync(LOG)) { console.error(`log not found: ${LOG}`); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI);
  const marks = mongoose.connection.db.collection('settlementcompensations');
  await marks.createIndex({ user: 1, day: 1 }, { unique: true });

  const rows = await readShortfalls();
  const users = new Set(rows.map(r => r.user));
  const total = rows.reduce((s, r) => s + r.shortfall, 0);
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: ${rows.length} underpaid days, ${users.size} users, ${total.toFixed(10)} BTC to credit (from ${LOG})`);

  // One read for all days already handled, instead of one per day.
  const done = new Set((await marks.find({}, { projection: { user: 1, day: 1 } }).toArray()).map(m => `${m.user}|${m.day}`));
  let credited = 0, creditedBtc = 0, skipped = 0, failed = 0;
  for (const r of rows.sort((a, b) => a.user.localeCompare(b.user) || a.day.localeCompare(b.day))) {
    if (done.has(`${r.user}|${r.day}`)) { skipped++; continue; }
    if (!APPLY) { credited++; creditedBtc += r.shortfall; continue; }
    const amountStr = r.shortfall.toFixed(16);
    try {
      // Mark first: if anything below fails the day is never retried blindly,
      // and it is visible here for an admin to look at.
      await marks.insertOne({ user: r.user, day: r.day, fromElapsed: r.fromElapsed, paid: r.paid, amount: r.shortfall, status: 'pending', createdAt: new Date() });
      const bal = await Balance.findOneAndUpdate(
        { user: r.user },
        { $inc: { BTC_DEPOSIT: mongoose.Types.Decimal128.fromString(amountStr) } },
        { new: true },
      );
      if (!bal) throw new Error('no balance record');
      const date = getHistoryDateFromSessionStartStr(r.day);
      const hist = await BalanceHistory.findOne({ user: r.user, date });
      if (hist) {
        const cur = parseFloat(hist.balances?.BTC?.toString() || '0');
        hist.balances.BTC = mongoose.Types.Decimal128.fromString((cur + r.shortfall).toFixed(16));
        await hist.save();
      } else {
        await BalanceHistory.create({ user: r.user, firebase_uid: bal.firebase_uid || undefined, date, balances: { BTC: mongoose.Types.Decimal128.fromString(amountStr) } });
      }
      await marks.updateOne({ user: r.user, day: r.day }, { $set: { status: 'credited', creditedAt: new Date() } });
      credited++; creditedBtc += r.shortfall;
    } catch (err) {
      failed++;
      console.error(`  FAILED ${r.user} ${r.day} ${amountStr}: ${err.message}`);
      await marks.updateOne({ user: r.user, day: r.day }, { $set: { status: 'failed', error: err.message } }).catch(() => {});
    }
  }
  console.log(`${APPLY ? 'credited' : 'would credit'} ${credited} days / ${creditedBtc.toFixed(10)} BTC; already done ${skipped}; failed ${failed}`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
