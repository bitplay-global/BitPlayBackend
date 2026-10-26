/**
 * Monthly renewal of mining packs.
 *
 * The packs are sold as auto-renewing subscriptions in Google Play and the App
 * Store, but until 2026-10-26 the backend granted a pack's hashpower once and
 * ignored every renewal: 27 buyers were charged again (about 36 renewals) and
 * received nothing for it. From then on:
 *
 *  - a new pack purchase gives its hashpower while the subscription is paid,
 *    and it comes off when the paid period ends (cancelled, refunded, or
 *    payment failed past the store's grace period);
 *  - a renewal keeps it on for the next period;
 *  - buyers from before keep their original hashpower permanently, and each
 *    period they renew after LEGACY_RENEWALS_FROM adds the pack's hashpower
 *    again for that period.
 *
 * RevenueCat is the only source of truth about periods. The webhook syncs a
 * customer when RevenueCat reports a change, and cronJobs.js re-syncs on a
 * timer, so a missed or refused webhook only delays a change, never loses it.
 *
 * RevenueCat knows buyers only by anonymous id, so a customer is linked to a
 * BitPlay user through the Purchase rows that carry its revenuecat_customer_id.
 */
import mongoose from 'mongoose';
import Purchase from '../models/Purchase.js';
import SubscriptionPlan from '../models/SubscriptionPlan.js';
import SubscriptionGrant from '../models/SubscriptionGrant.js';
import UserMiningDetail from '../models/UserMiningDetails.js';
import { getSubscriber } from './revenueCatVerify.js';
import { hashpowerForPlan } from './grantPlanPurchase.js';
import { matchPlanProduct } from './matchPlanProduct.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Renewals charged before this were not honoured at the time; they are listed
// by scripts/list-past-renewals.js for an admin to decide on, not granted here.
const DEFAULT_LEGACY_RENEWALS_FROM = '2026-10-26T00:00:00Z';

export function legacyRenewalsFrom() {
  const d = new Date(process.env.LEGACY_RENEWALS_FROM || DEFAULT_LEGACY_RENEWALS_FROM);
  return Number.isNaN(d.getTime()) ? new Date(DEFAULT_LEGACY_RENEWALS_FROM) : d;
}

const toDate = v => (v ? new Date(v) : null);

/** End of the paid period, counting the store's billing grace period. */
export function periodEnd(entry) {
  const ends = [toDate(entry?.expires_date), toDate(entry?.grace_period_expires_date)].filter(Boolean);
  return ends.length ? new Date(Math.max(...ends.map(d => d.getTime()))) : null;
}

/** "sku:basePlan" for a Google entry stored under the bare sku, else the key. */
export function entryProduct(key, entry) {
  return !key.includes(':') && entry?.product_plan_identifier ? `${key}:${entry.product_plan_identifier}` : key;
}

/**
 * Whether this grant's hashpower should be on right now.
 * @param legacyFrom date the legacy grant's original purchase was made (its permanent grant)
 */
export function shouldBeActive(grant, entry, now = new Date(), legacySince = null) {
  if (!entry) return false;
  if (entry.refunded_at) return false;
  if (entry.is_sandbox === true && process.env.ALLOW_SANDBOX_PURCHASES !== 'true') return false;
  const end = periodEnd(entry);
  if (!end || end <= now) return false;
  if (!grant.legacy) return true;
  // Legacy: only a period paid after the cut-over, and not the original
  // purchase (that one already gave permanent hashpower).
  const started = toDate(entry.purchase_date);
  if (!started || started < legacyRenewalsFrom()) return false;
  const original = legacySince || toDate(entry.original_purchase_date);
  return !original || started.getTime() - original.getTime() > DAY_MS;
}

export async function addHashpower(userId, delta, session) {
  // Never below zero, whatever happened to the row in between.
  const r = await UserMiningDetail.collection.updateOne(
    { user: String(userId) }, // stored as a string in userminings
    [{ $set: {
      purchasedHashpower: { $max: [0, { $add: [{ $ifNull: ['$purchasedHashpower', 0] }, delta] }] },
      hashpower: { $max: [0, { $add: [{ $ifNull: ['$hashpower', 0] }, delta] }] },
    } }],
    { session },
  );
  return r.matchedCount > 0;
}

/** Turns a grant on or off, together with the user's hashpower. */
async function setActive(grant, on, entry, reason) {
  const session = await mongoose.startSession();
  try {
    let done = false;
    await session.withTransaction(async () => {
      const g = await SubscriptionGrant.findOneAndUpdate(
        { _id: grant._id, active: !on },
        {
          $set: { active: on, expires_at: periodEnd(entry), period_purchase_date: toDate(entry?.purchase_date), last_checked_at: new Date() },
          $push: { history: { change: on ? 'on' : 'off', hashpower: grant.hashpower, purchase_date: toDate(entry?.purchase_date), expires_at: periodEnd(entry), reason } },
        },
        { session, new: true },
      );
      if (!g) return; // someone else already flipped it
      if (!(await addHashpower(g.user, on ? g.hashpower : -g.hashpower, session))) {
        throw new Error(`no mining record for user ${g.user}`);
      }
      done = true;
    });
    if (done) {
      console.log(`[Subscriptions] ${on ? 'ON ' : 'OFF'} ${grant.hashpower} GH/s for user ${grant.user} (${grant.product_identifier}${grant.legacy ? ', legacy renewal' : ''}): ${reason}`);
    }
    return done;
  } finally {
    session.endSession();
  }
}

function describe(entry, now) {
  if (!entry) return 'subscription no longer listed';
  if (entry.refunded_at) return 'refunded';
  const end = periodEnd(entry);
  if (!end || end <= now) return `paid period ended ${end ? end.toISOString() : '(no expiry)'}`;
  return `paid until ${end.toISOString()}`;
}

/**
 * Brings every pack subscription of one RevenueCat customer in line with
 * RevenueCat. Safe to call any number of times.
 * @returns {Promise<{customer: string, checked: number, on: number, off: number, extended: number}>}
 */
export async function syncCustomer(rcCustomerId, { subscriber = null, now = new Date() } = {}) {
  const out = { customer: rcCustomerId, checked: 0, on: 0, off: 0, extended: 0 };
  const purchases = await Purchase.find({ revenuecat_customer_id: rcCustomerId }).sort({ purchase_date: 1 }).lean();
  if (!purchases.length) return out;
  const sub = subscriber || await getSubscriber(rcCustomerId);
  const plans = await SubscriptionPlan.find({}).lean();

  for (const [key, entry] of Object.entries(sub?.subscriptions || {})) {
    const product = entryProduct(key, entry);
    const plan = plans.find(p => matchPlanProduct(p, product) || matchPlanProduct(p, key));
    if (!plan) continue;

    let grant = await SubscriptionGrant.findOne({ rc_customer_id: rcCustomerId, rc_key: key });
    const original = purchases.find(p => String(p.plan_id) === String(plan._id));
    if (!grant) {
      // Bought before renewals were honoured (or recorded by an older path):
      // the original purchase keeps its permanent hashpower.
      if (!original) continue; // never applied at all: scripts/recover-purchases.js
      try {
        grant = await SubscriptionGrant.create({
          user: original.user, plan_id: plan._id, product_identifier: product,
          rc_customer_id: rcCustomerId, rc_key: key, purchase_id: original._id,
          hashpower: hashpowerForPlan(plan), legacy: true, active: false,
          period_purchase_date: toDate(entry.purchase_date),
        });
      } catch (err) {
        if (err?.code !== 11000) throw err;
        grant = await SubscriptionGrant.findOne({ rc_customer_id: rcCustomerId, rc_key: key });
      }
    }
    out.checked += 1;

    const legacySince = grant.legacy && original ? toDate(original.purchase_date) : null;
    const want = shouldBeActive(grant, entry, now, legacySince);
    if (want !== grant.active) {
      if (await setActive(grant, want, entry, describe(entry, now))) out[want ? 'on' : 'off'] += 1;
      continue;
    }
    const end = periodEnd(entry);
    const changed = String(end?.getTime()) !== String(grant.expires_at?.getTime?.());
    await SubscriptionGrant.updateOne(
      { _id: grant._id },
      changed && grant.active
        ? { $set: { expires_at: end, period_purchase_date: toDate(entry.purchase_date), last_checked_at: now },
            $push: { history: { change: 'extend', hashpower: grant.hashpower, purchase_date: toDate(entry.purchase_date), expires_at: end, reason: describe(entry, now) } } }
        : { $set: { expires_at: end, period_purchase_date: toDate(entry.purchase_date), last_checked_at: now } },
    );
    if (changed && grant.active) {
      out.extended += 1;
      console.log(`[Subscriptions] renewed: user ${grant.user} keeps ${grant.hashpower} GH/s (${product}) ${describe(entry, now)}`);
    }
  }
  return out;
}

let running = false;

/**
 * Re-syncs customers from RevenueCat. `due` only checks grants whose paid
 * period has ended (hourly); `all` checks every buyer (a few times a day),
 * which is what notices renewals when no webhook arrives.
 */
export async function reconcileSubscriptions({ scope = 'due', now = new Date(), delayMs = 250 } = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  const totals = { customers: 0, on: 0, off: 0, extended: 0, errors: 0 };
  try {
    const ids = scope === 'all'
      ? (await Purchase.distinct('revenuecat_customer_id', { revenuecat_customer_id: { $type: 'string', $ne: '' } }))
      : (await SubscriptionGrant.distinct('rc_customer_id', { active: true, expires_at: { $lte: now } }));
    for (const id of ids) {
      try {
        const r = await syncCustomer(id, { now });
        totals.customers += 1; totals.on += r.on; totals.off += r.off; totals.extended += r.extended;
      } catch (err) {
        totals.errors += 1;
        console.warn(`[Subscriptions] could not sync ${id}: ${err.code || err.message}`);
      }
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    }
    if (totals.on || totals.off || totals.extended || totals.errors) {
      console.log(`[Subscriptions] reconcile ${scope}: ${JSON.stringify(totals)}`);
    }
    return totals;
  } finally {
    running = false;
  }
}
