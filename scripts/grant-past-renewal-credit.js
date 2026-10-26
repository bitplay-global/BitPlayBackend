/**
 * Goodwill credit for pack renewals charged before monthly renewal was
 * honoured (2026-10-26): for each subscription on scripts/list-past-renewals.js,
 * the pack's hashpower (Buy 1 Get 1 included) for as many months as renewals
 * were missed, starting now, then removed automatically (helpers/bonusGrants.js).
 *
 * Preview by default; nothing changes without --apply. Running it again never
 * credits the same subscription twice.
 *
 *   node scripts/grant-past-renewal-credit.js                       preview
 *   node scripts/grant-past-renewal-credit.js --apply               grant
 *   ... --exclude a@x.com,b@y.com                                   skip people
 */
import '../config/loadEnv.js';
import mongoose from 'mongoose';
import BonusGrant from '../models/BonusGrant.js';
import { findPastRenewals } from '../helpers/pastRenewals.js';
import { grantBonus } from '../helpers/bonusGrants.js';

const DAYS_PER_MONTH = 30;
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const ex = args.indexOf('--exclude');
const exclude = new Set((ex >= 0 ? args[ex + 1] || '' : '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

await mongoose.connect(process.env.MONGODB_URI);
await BonusGrant.syncIndexes();
const now = new Date();
const { rows, errors } = await findPastRenewals({ now });

const keyOf = r => `past-renewals:${r.rc_customer_id}:${r.rc_key}`;
const done = new Set((await BonusGrant.find({ key: { $in: rows.map(keyOf) } }, { key: 1 }).lean()).map(g => g.key));
let count = 0, skipped = 0, already = 0, failed = 0, ghMonths = 0;

console.log(`${apply ? 'GRANTING' : 'PREVIEW (nothing is changed; add --apply to grant)'}\n`);
for (const r of rows) {
  const months = r.est_unrewarded_renewals;
  const until = new Date(now.getTime() + months * DAYS_PER_MONTH * 864e5);
  const line = `${r.email || r.user_id} | ${r.plan} | ${r.gh_per_month} GH/s x ${months} month(s) until ${until.toISOString().slice(0, 10)} | paid ${r.price}`;
  if (exclude.has(r.email.toLowerCase())) { skipped += 1; console.log(`  skip     ${line} (excluded)`); continue; }
  if (done.has(keyOf(r))) { already += 1; console.log(`  already  ${line}`); continue; }
  if (!apply) { count += 1; ghMonths += r.gh_per_month * months; console.log(`  would    ${line}`); continue; }
  try {
    const res = await grantBonus({
      key: keyOf(r), userId: r.user_id, hashpower: r.gh_per_month, expiresAt: until, now,
      reason: `goodwill: ${months} ${r.plan} renewal(s) charged before 2026-10-26 (${r.first_charge} to ${r.latest_charge})`,
    });
    if (res === 'exists') { already += 1; console.log(`  already  ${line}`); continue; }
    count += 1; ghMonths += r.gh_per_month * months; console.log(`  granted  ${line}`);
  } catch (err) {
    failed += 1; console.log(`  FAILED   ${line}: ${err.message}`);
  }
}

console.log(`\n${apply ? 'granted' : 'would grant'} ${count} credit(s) to ${new Set(rows.filter(r => !exclude.has(r.email.toLowerCase())).map(r => r.user_id)).size} user(s), ` +
  `${ghMonths} GH/s-months in total; already credited ${already}, excluded ${skipped}, failed ${failed}, RevenueCat errors ${errors}`);
await mongoose.disconnect();
