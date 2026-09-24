#!/usr/bin/env node
/**
 * Pays the mining days lost to stuck sessions and repairs their streaks.
 * Rules: helpers/stuckSessionCompensation.js. Run on the server as root, from
 * the backend folder (it reads the nginx logs).
 *
 * 1. Before deploying the settlement fix (or any time), record the sessions
 *    that are stuck right now -- the fix's first hourly run resets them and
 *    wipes their hashpower (the fixed settlement also records them itself):
 *
 *      node scripts/compensate-stuck-sessions.js --snapshot
 *
 *    If the fixed settlement already reset them before a snapshot was taken,
 *    recover them from its log instead (paid at each user's own average daily
 *    mining before they got stuck, since the reset wiped the hashpower):
 *
 *      node scripts/compensate-stuck-sessions.js --from-log
 *      (reads /home/pi/.pm2/logs/admin-panel-out.log; --from-log=<file> for another)
 *
 *    Where the exact hashpower someone was stuck at is known (e.g. from
 *    scripts/diagnose-user.js before the reset), use it instead of the average:
 *
 *      node scripts/compensate-stuck-sessions.js --hashpower=<email>:<GH/s>
 *
 * 2. After the fix has run, see what would be paid (changes nothing):
 *
 *      node scripts/compensate-stuck-sessions.js
 *
 * 3. Pay it:
 *
 *      node scripts/compensate-stuck-sessions.js --apply
 *
 * Re-running is safe: a day already paid is skipped.
 */
import '../config/loadEnv.js';
import mongoose from 'mongoose';
import fs from 'fs';
import {
  snapshotStuckSessions, recordFromSettlementLog, setKnownHashpower, readNginxLogs, activeDaysFromLogText, planCompensation, applyCompensation, BTC_PER_GH_PER_DAY,
} from '../helpers/stuckSessionCompensation.js';
import StuckSessionRecovery from '../models/StuckSessionRecovery.js';

const fmt = n => n.toFixed(10);

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter(a => !['--snapshot', '--apply', '--from-log'].includes(a) && !a.startsWith('--nginx-dir=') && !a.startsWith('--from-log=') && !a.startsWith('--hashpower='));
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(' ')}`);
  const nginxDir = args.find(a => a.startsWith('--nginx-dir='))?.split('=')[1] || '/var/log/nginx';
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set (.env next to server.js).');
  await mongoose.connect(process.env.MONGODB_URI);

  if (args.includes('--snapshot')) {
    const { stuck, recorded } = await snapshotStuckSessions();
    console.log(`\nStuck right now: ${stuck}. Newly recorded: ${recorded} (already recorded: ${stuck - recorded}).`);
    console.log('Next: deploy the fix, wait for the next full hour, then run this script without --snapshot.\n');
    return;
  }

  const hp = args.find(a => a.startsWith('--hashpower='));
  if (hp) {
    const [who, gh] = hp.slice('--hashpower='.length).split(':');
    const u = await mongoose.connection.collection('users').findOne(
      /^[0-9a-f]{24}$/i.test(who) ? { _id: new mongoose.Types.ObjectId(who) } : { email: new RegExp(`^${who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
      { projection: { _id: 1, email: 1 } });
    if (!u) throw new Error(`No user ${who}`);
    const n = await setKnownHashpower(String(u._id), Number(gh));
    console.log(`\n${u.email}: ${n ? `stuck hashpower set to ${Number(gh)} GH/s` : 'no unpaid stuck session found -- nothing changed'}.\n`);
    return;
  }

  const fromLog = args.find(a => a === '--from-log' || a.startsWith('--from-log='));
  if (fromLog) {
    const file = fromLog.includes('=') ? fromLog.split('=')[1] : '/home/pi/.pm2/logs/admin-panel-out.log';
    const { found, recorded } = await recordFromSettlementLog(fs.readFileSync(file, 'utf8'));
    console.log(`\nStuck sessions found in ${file}: ${found}. Newly recorded: ${recorded} (already recorded: ${found - recorded}).`);
    console.log('Next: run this script without options to see what would be paid.\n');
    return;
  }

  const records = await StuckSessionRecovery.find({}).lean();
  if (!records.length) {
    console.log('\nNo stuck sessions recorded. Run with --snapshot first (before the fixed settlement resets them).\n');
    return;
  }
  const zones = new Map(records.map(r => [r.user, { timezone: r.timezone, offset: r.offset }]));
  const { texts, oldest } = readNginxLogs(nginxDir);
  const activeDays = activeDaysFromLogText(texts, zones);
  const plans = await planCompensation({ activeDays, logsFrom: oldest });

  const emails = new Map();
  for (const u of await mongoose.connection.collection('users')
    .find({ _id: { $in: records.map(r => new mongoose.Types.ObjectId(r.user)) } }, { projection: { email: 1 } }).toArray()) {
    emails.set(String(u._id), u.email);
  }

  const apply = args.includes('--apply');
  console.log(`\nNginx logs reach back to ${oldest || '(none found)'}. Rate: ${BTC_PER_GH_PER_DAY.toExponential(4)} BTC per GH/s per day.`);
  console.log(`${records.length} stuck session(s)${apply ? '' : '  [DRY RUN -- nothing will change]'}\n`);

  let totalBtc = 0, totalDays = 0;
  for (const p of plans) {
    const who = emails.get(p.rec.user) || p.rec.user;
    const basis = p.basis ? `${p.basis} = ${fmt(p.perDay)} BTC/day` : 'no basis';
    console.log(`  ${who}  (${basis}, stuck from ${p.rec.sessionDay}${p.settledDay ? `, reset ${p.settledDay}` : ''})`);
    if (p.note) { console.log(`     ${p.note}`); continue; }
    const btc = p.pay.reduce((s, x) => s + x.btc, 0);
    totalBtc += btc; totalDays += p.pay.length;
    console.log(`     pay ${p.pay.length} day(s): ${p.pay.map(x => x.day).join(', ') || '-'}  = ${fmt(btc)} BTC`);
    if (p.skipped.length) {
      // Group by reason: "12 day(s) app not opened", not a date per line.
      const byReason = new Map();
      for (const x of p.skipped) {
        const [, day, why] = x.match(/^(\S+) \((.*)\)$/) || [null, x, 'other'];
        if (!byReason.has(why)) byReason.set(why, []);
        byReason.get(why).push(day);
      }
      for (const [why, ds] of byReason) {
        console.log(`     not paid, ${why}: ${ds.length} day(s)${ds.length <= 4 ? ` (${ds.join(', ')})` : ` (${ds[0]} .. ${ds.at(-1)})`}`);
      }
    }
    if (p.streak) console.log(`     streak: ${p.streak.before} (last ${p.streak.beforeLast || '-'}) -> ${p.streak.after} (last ${p.streak.afterLast || '-'})${p.streak.after > p.streak.before ? '' : '  unchanged'}`);
  }
  console.log(`\nTotal: ${totalDays} day(s), ${fmt(totalBtc)} BTC, plus 5% to referrers where a user has one.`);

  if (!apply) { console.log('Dry run only. Re-run with --apply to pay it.\n'); return; }

  const results = await applyCompensation(plans);
  console.log('');
  let paidBtc = 0, errors = 0;
  for (const r of results) {
    const who = emails.get(r.user) || r.user;
    paidBtc += r.btc; errors += r.errors.length;
    if (r.paidDays.length || r.alreadyPaid.length || r.errors.length || r.streak) {
      console.log(`  ${who}: paid ${r.paidDays.length} day(s) ${fmt(r.btc)} BTC${r.alreadyPaid.length ? `, already paid ${r.alreadyPaid.length}` : ''}${r.streak ? `, streak ${r.streak.before} -> ${r.streak.after}` : ''}${r.errors.length ? `  ERRORS: ${r.errors.join('; ')}` : ''}`);
    }
  }
  console.log(`\nPaid ${fmt(paidBtc)} BTC. ${errors ? `${errors} error(s) above.` : 'No errors.'} Users see it in their balance history.\n`);
  if (errors) process.exitCode = 1;
}

main()
  .catch(err => { console.error(`\nError: ${err.message}`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
