/**
 * Lists pack renewals that were charged before monthly renewal was honoured
 * (LEGACY_RENEWALS_FROM, 2026-10-26) and so granted nothing. Read-only: it
 * changes nothing, it is the list an admin decides on.
 *
 * RevenueCat's subscriber record has the first and the latest charge of each
 * subscription, not every charge, so the count is estimated from the months
 * between them; Play Console > Order management has the exact orders.
 *
 *   node scripts/list-past-renewals.js [out.csv]
 */
import '../config/loadEnv.js';
import fs from 'fs';
import mongoose from 'mongoose';
import Purchase from '../models/Purchase.js';
import SubscriptionPlan from '../models/SubscriptionPlan.js';
import { getSubscriber } from '../helpers/revenueCatVerify.js';
import { matchPlanProduct } from '../helpers/matchPlanProduct.js';
import { hashpowerForPlan } from '../helpers/grantPlanPurchase.js';
import { legacyRenewalsFrom, entryProduct, periodEnd } from '../helpers/subscriptionGrants.js';

const MONTH_MS = 30.44 * 24 * 60 * 60 * 1000;

await mongoose.connect(process.env.MONGODB_URI);
const cutoff = legacyRenewalsFrom();
const now = new Date();
const plans = await SubscriptionPlan.find({}).lean();
const users = mongoose.connection.collection('users');
const ids = await Purchase.distinct('revenuecat_customer_id', { revenuecat_customer_id: { $type: 'string', $ne: '' } });

const rows = [];
let errors = 0;
for (const id of ids) {
  let sub;
  try { sub = await getSubscriber(id); } catch (err) { errors += 1; console.warn(`skip ${id}: ${err.code || err.message}`); continue; }
  const bought = await Purchase.find({ revenuecat_customer_id: id }).sort({ purchase_date: 1 }).lean();
  for (const [key, e] of Object.entries(sub?.subscriptions || {})) {
    if (e.is_sandbox) continue;
    const plan = plans.find(p => matchPlanProduct(p, entryProduct(key, e)) || matchPlanProduct(p, key));
    const original = plan && bought.find(p => String(p.plan_id) === String(plan._id));
    if (!original) continue;
    const first = new Date(e.original_purchase_date || original.purchase_date);
    const latest = new Date(e.purchase_date);
    let renewals = Math.round((latest - first) / MONTH_MS);
    if (latest >= cutoff && renewals > 0) renewals -= 1; // that one is honoured live
    if (renewals <= 0) continue;
    const u = await users.findOne({ _id: new mongoose.Types.ObjectId(String(original.user)) }, { projection: { email: 1, name: 1 } });
    const end = periodEnd(e);
    rows.push({
      email: u?.email || '', name: u?.name || '', user_id: String(original.user), plan: plan.name,
      gh_per_month: hashpowerForPlan(plan), store: e.store, first_charge: first.toISOString().slice(0, 10),
      latest_charge: latest.toISOString().slice(0, 10), est_unrewarded_renewals: renewals,
      price: e.price?.amount != null ? `${e.price.amount} ${e.price.currency}` : `${original.price_paid} ${original.currency}`,
      still_renewing: !e.unsubscribe_detected_at && !e.refunded_at && end && end > now ? 'yes' : 'no',
      refunded: e.refunded_at ? 'yes' : 'no',
    });
  }
  await new Promise(r => setTimeout(r, 200));
}

rows.sort((a, b) => b.est_unrewarded_renewals - a.est_unrewarded_renewals);
const cols = Object.keys(rows[0] || { email: '' });
const csv = [cols.join(','), ...rows.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
if (process.argv[2]) fs.writeFileSync(process.argv[2], csv + '\n');
else console.log(csv);
console.error(`\ncustomers checked ${ids.length}, errors ${errors}; users with unrewarded renewals ${rows.length}, ` +
  `estimated renewals ${rows.reduce((s, r) => s + r.est_unrewarded_renewals, 0)}, still auto-renewing ${rows.filter(r => r.still_renewing === 'yes').length}; cut-over ${cutoff.toISOString()}`);
await mongoose.disconnect();
