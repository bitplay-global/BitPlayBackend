#!/usr/bin/env node
/**
 * Applies plan purchases that RevenueCat recorded but the backend refused.
 * See helpers/recoverPurchases.js for why they were refused, how buyers are
 * matched to accounts, and every safety check. Run on the server, from the
 * backend folder.
 *
 * RevenueCat knows buyers only by anonymous id ($RCAnonymousID:...), so each
 * purchase has to be paired with the BitPlay account that tried to record it:
 *
 *   rc-ids.txt   the RevenueCat customers who bought since the date -- copy
 *                their App User IDs from the RevenueCat dashboard, one per line
 *   nginx logs   every refused POST /api/purchases/<userId>, with its time
 *
 * 1. Dry run (the default) -- shows the pairing and what would be applied:
 *
 *    node scripts/recover-purchases.js --since 2026-09-14 --rc-ids rc-ids.txt --nginx-log refused.log
 *
 * 2. Apply, once the dry run looks right:
 *
 *    node scripts/recover-purchases.js --since 2026-09-14 --rc-ids rc-ids.txt --nginx-log refused.log --apply
 *
 * A pairing you already know can be given directly, alone or alongside:
 *    --pair <bitplayUserId>=<revenueCatId>
 *
 * Running it twice is safe: applied purchases are skipped.
 */
import '../config/loadEnv.js';
import fs from 'fs';
import mongoose from 'mongoose';
import { findRecoverable, applyRecoverable, matchRefusals, parseNginxRefusals } from '../helpers/recoverPurchases.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

function parseArgs(argv) {
  const args = { apply: false, allowSandbox: false, rcIdFiles: [], nginxLogs: [], pairs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--apply') args.apply = true;
    else if (a === '--allow-sandbox') args.allowSandbox = true;
    else if (a === '--since') args.since = next();
    else if (a === '--rc-ids') args.rcIdFiles.push(next());
    else if (a === '--nginx-log') args.nginxLogs.push(next());
    else if (a === '--pair') args.pairs.push(...next().split(','));
    else throw new Error(`Unknown option: ${a}`);
  }
  return args;
}

/** RevenueCat App User IDs from pasted dashboard text: anonymous ids or 24-hex user ids. */
export function rcIdsFromText(text) {
  const ids = new Set();
  for (const m of text.matchAll(/\$RCAnonymousID:[0-9a-f]+|\b[0-9a-f]{24}\b/gi)) ids.add(m[0]);
  return [...ids];
}

export function parsePair(spec) {
  const [userId, rcId] = spec.split('=').map(s => s?.trim());
  if (!OBJECT_ID.test(userId || '') || !rcId) {
    throw new Error(`--pair must be <bitplayUserId>=<revenueCatId>, got: ${spec}`);
  }
  return { userId: userId.toLowerCase(), rcId };
}

const fmtDate = d => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '-');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.since) {
    throw new Error('--since YYYY-MM-DD is required: only purchases from that date on are considered. Use the day the refusals began (2026-09-14).');
  }
  const explicit = args.pairs.map(parsePair);
  if (!explicit.length && !(args.rcIdFiles.length && args.nginxLogs.length)) {
    throw new Error('Give --rc-ids <file> with --nginx-log <file> (automatic matching), and/or --pair <userId>=<revenueCatId>.');
  }
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set (.env next to server.js).');
  if (!process.env.REVENUECAT_SECRET_KEY) throw new Error('REVENUECAT_SECRET_KEY is not set (.env next to server.js).');

  await mongoose.connect(process.env.MONGODB_URI);

  const pairs = [...explicit];
  if (args.rcIdFiles.length) {
    const rcIds = [...new Set(args.rcIdFiles.flatMap(f => rcIdsFromText(fs.readFileSync(f, 'utf8'))))]
      .filter(id => !explicit.some(p => p.rcId === id));
    const refusals = args.nginxLogs.flatMap(f => parseNginxRefusals(fs.readFileSync(f, 'utf8')));
    console.log(`\nMatching ${rcIds.length} RevenueCat customer(s) against ${refusals.length} refused purchase call(s)...`);
    const { pairs: matched, problems } = await matchRefusals({ refusals, rcIds, since: args.since });
    for (const p of matched) console.log(`  paired   ${p.rcId}  ->  user ${p.userId}`);
    for (const p of problems) {
      console.log(`  unpaired ${p.rcId}: ${p.reason}`);
      for (const b of p.bought || []) console.log(`             bought ${b}`);
    }
    pairs.push(...matched);
  }
  if (!pairs.length) {
    console.log('\nNothing to check: no customer could be paired with an account.');
    return;
  }

  const users = mongoose.connection.collection('users');
  const emailOf = new Map();
  for (const u of await users.find({ _id: { $in: pairs.map(p => new mongoose.Types.ObjectId(p.userId)) } }, { projection: { email: 1 } }).toArray()) {
    emailOf.set(u._id.toString(), u.email);
  }
  for (const p of pairs) {
    if (!emailOf.has(p.userId)) console.log(`  ! user ${p.userId} does not exist -- its purchases will fail to apply`);
  }

  console.log(`\nChecking ${pairs.length} pairing(s) with RevenueCat, purchases since ${args.since}${args.apply ? '' : '  [DRY RUN -- nothing will change]'}\n`);
  const rows = await findRecoverable({ pairs, since: args.since, allowSandbox: args.allowSandbox });

  const toApply = rows.filter(r => r.status === 'apply');
  for (const r of rows) {
    const who = emailOf.get(r.userId) || r.userId;
    if (r.status === 'error') { console.log(`  ERROR  ${who} (${r.rcId}): ${r.reason}`); continue; }
    const what = `${r.planName || r.product} | ${fmtDate(r.purchasedAt)} | ${r.store} | txn ${r.transactionId || '-'}`;
    if (r.status === 'apply') console.log(`  APPLY  ${who}: ${what} | +${r.hashpower} GH/s`);
    else console.log(`  skip   ${who}: ${what} -- ${r.reason}`);
  }

  console.log(`\n${toApply.length} purchase(s) to apply, ${rows.length - toApply.length} skipped.`);
  if (!args.apply) {
    if (toApply.length) console.log('Dry run only. Re-run with --apply to credit them.');
    return;
  }

  const results = await applyRecoverable(rows);
  console.log('');
  for (const r of results) {
    const who = emailOf.get(r.userId) || r.userId;
    console.log(`  ${r.result === 'applied' ? 'DONE ' : 'FAIL '}  ${who}: ${r.planName} -- ${r.result}${r.purchaseId ? ` (purchase ${r.purchaseId}, +${r.hashpowerAdded} GH/s)` : ''}`);
  }
  const done = results.filter(r => r.result === 'applied').length;
  console.log(`\nApplied ${done} of ${results.length}. They now show in the admin panel under Purchases.`);
  if (done !== results.length) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch(err => { console.error(`\nError: ${err.message}`); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}
