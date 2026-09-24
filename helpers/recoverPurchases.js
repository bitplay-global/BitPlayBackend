/**
 * Finds plan purchases RevenueCat has on record but the backend never applied,
 * and applies them. Used by scripts/recover-purchases.js.
 *
 * Why this exists: from 2026-09-14 the plan/product check refused Android
 * purchases (the app reports the bare Google sku, plans store "sku:basePlan"),
 * and while JWT_SECRET was missing every signed-in purchase got a 503. Those
 * users paid, RevenueCat recorded it, and the backend saved nothing. The app
 * never retries, so they stay unapplied until reconciled here.
 *
 * The app never calls Purchases.logIn, so RevenueCat knows each buyer only by
 * an anonymous id ($RCAnonymousID:...), not by BitPlay user id. Recovery
 * therefore works on pairs {userId, rcId}. matchRefusals() builds them: nginx
 * logs every refused POST /api/purchases/<userId> with its time, RevenueCat has
 * every purchase with its time, and a refusal follows its purchase by seconds.
 *
 * Safety, in order:
 *  - Every transaction comes from RevenueCat, not from anyone's claim.
 *  - Refunded and sandbox transactions are never applied.
 *  - Only transactions on or after `since` are considered.
 *  - A transaction already recorded (same store_transaction_id) is skipped;
 *    the unique index enforces this even if two runs race.
 *  - Purchases saved before verification existed carry no transaction id, so a
 *    row for the same user and plan within LEGACY_WINDOW of the store date is
 *    treated as the same purchase and skipped for a human to look at.
 */
import Purchase from '../models/Purchase.js';
import SubscriptionPlan from '../models/SubscriptionPlan.js';
import { getSubscriber } from './revenueCatVerify.js';
import { grantPlanPurchase, hashpowerForPlan } from './grantPlanPurchase.js';
import { matchPlanProduct } from './matchPlanProduct.js';

const LEGACY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** Every store transaction on a RevenueCat subscriber, flattened. */
export function listTransactions(subscriber) {
  const out = [];
  for (const [key, list] of Object.entries(subscriber?.non_subscriptions || {})) {
    for (const t of Array.isArray(list) ? list : []) out.push({ key, product: key, t });
  }
  for (const [key, t] of Object.entries(subscriber?.subscriptions || {})) {
    const product = !key.includes(':') && t?.product_plan_identifier ? `${key}:${t.product_plan_identifier}` : key;
    out.push({ key, product, t, subscription: true });
  }
  return out;
}

// Must match verifyStorePurchase, so a later live retry of the same purchase
// is recognised as already applied.
function transactionIdOf(t, product) {
  const id = t.store_transaction_id || t.id || (t.purchase_date ? `${product}@${t.purchase_date}` : null);
  return id ? String(id) : null;
}

/**
 * Refused purchase calls from an nginx access log (combined format):
 *   ... [15/Sep/2026:10:03:14 +0000] "POST /api/purchases/<userId> HTTP/1.1" 400 ...
 * Super Privileges calls (POST /api/privileges/<userId>) count too: they
 * identify the buyer just as well, and were refused in the same outages.
 * Only 4xx/5xx answers count; a 2xx purchase was recorded normally.
 */
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
export function parseNginxRefusals(text) {
  const out = [];
  const re = /\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\] "POST \/api\/(?:purchases|privileges)\/([0-9a-f]{24})[^"]*" (\d{3})/i;
  for (const line of text.split('\n')) {
    const m = line.match(re);
    if (!m || Number(m[9]) < 400 || !(m[2] in MONTHS)) continue;
    const [, dd, mon, yyyy, hh, mi, ss, tz] = m;
    const offsetMin = (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
    const at = new Date(Date.UTC(Number(yyyy), MONTHS[mon], Number(dd), Number(hh), Number(mi), Number(ss)) - offsetMin * 60000);
    out.push({ userId: m[8].toLowerCase(), at, status: Number(m[9]) });
  }
  return out;
}

// A refusal is the app's sync call right after the store confirmed payment.
const MATCH_BEFORE_MS = 60 * 1000;      // clock skew between RevenueCat and nginx
const MATCH_AFTER_MS = 10 * 60 * 1000;  // slow networks, app backgrounded mid-sync

/**
 * Pairs RevenueCat customers with BitPlay users by time: each of the customer's
 * purchases since `since` is matched to refused calls that came just after it.
 * A customer is paired only when every match points to one single user.
 */
export async function matchRefusals({ refusals, rcIds, since }) {
  const sinceDate = new Date(since);
  const pairs = [];
  const problems = [];
  for (const rcId of rcIds) {
    let subscriber;
    try {
      subscriber = await getSubscriber(rcId);
    } catch (err) {
      problems.push({ rcId, reason: `RevenueCat: ${err.code || err.message}` });
      continue;
    }
    const users = new Set();
    const bought = [];
    let recent = 0;
    for (const { product, t } of listTransactions(subscriber)) {
      const at = t.purchase_date ? new Date(t.purchase_date) : null;
      if (!at || at < sinceDate) continue;
      recent++;
      bought.push(`${product} @ ${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
      for (const r of refusals) {
        const d = r.at - at;
        if (d >= -MATCH_BEFORE_MS && d <= MATCH_AFTER_MS) users.add(r.userId);
      }
    }
    if (recent === 0) problems.push({ rcId, reason: 'no purchases since --since', bought });
    else if (users.size === 0) problems.push({ rcId, reason: 'no refused purchase call near its purchase time', bought });
    else if (users.size > 1) problems.push({ rcId, reason: `ambiguous: refused calls from ${[...users].join(', ')} -- pair by hand with --pair`, bought });
    else pairs.push({ userId: [...users][0], rcId });
  }
  return { pairs, problems };
}

/**
 * Returns one entry per RevenueCat transaction for each {userId, rcId} pair,
 * each with a `status`: 'apply' (safe to apply) or a skip reason. Transactions
 * are credited to userId; rcId is only where RevenueCat files them.
 */
export async function findRecoverable({ pairs, since, allowSandbox = false }) {
  const sinceDate = new Date(since);
  if (Number.isNaN(sinceDate.getTime())) throw new Error(`Invalid --since date: ${since}`);
  const plans = await SubscriptionPlan.find({}).lean();
  const rows = [];

  for (const { userId, rcId } of pairs) {
    let subscriber;
    try {
      subscriber = await getSubscriber(rcId);
    } catch (err) {
      rows.push({ userId, rcId, status: 'error', reason: `RevenueCat: ${err.code || err.message}` });
      continue;
    }

    for (const { product, t, subscription } of listTransactions(subscriber)) {
      const purchasedAt = t.purchase_date ? new Date(t.purchase_date) : null;
      const plan = plans.find(p => matchPlanProduct(p, product));
      const row = {
        userId,
        rcId,
        product,
        planId: plan?._id?.toString() ?? null,
        planName: plan?.name ?? null,
        purchasedAt,
        transactionId: transactionIdOf(t, product),
        store: t.store || 'unknown',
        price: t.price?.amount ?? null,
        currency: t.price?.currency ?? null,
        hashpower: plan ? hashpowerForPlan(plan) : null,
      };
      const skip = reason => rows.push({ ...row, status: 'skip', reason });

      if (!plan) { skip('not a mining plan (e.g. Super Privileges)'); continue; }
      if (!purchasedAt || purchasedAt < sinceDate) { skip('before --since'); continue; }
      if (t.refunded_at) { skip('refunded'); continue; }
      if (t.is_sandbox === true && !allowSandbox) { skip('sandbox / test purchase'); continue; }
      if (!row.transactionId) { skip('no transaction id from RevenueCat'); continue; }
      // RevenueCat reports only a subscription's latest period. If that is a
      // renewal, the first purchase may already have been applied under an
      // earlier transaction id, and the app has never credited renewals.
      if (subscription && t.original_purchase_date && t.original_purchase_date !== t.purchase_date) {
        skip('subscription renewal -- check by hand'); continue;
      }

      if (await Purchase.exists({ store_transaction_id: row.transactionId })) {
        skip('already applied'); continue;
      }
      const legacy = await Purchase.findOne({
        user: userId,
        plan_id: plan._id,
        store_transaction_id: null, // matches missing too
        purchase_date: {
          $gte: new Date(purchasedAt.getTime() - LEGACY_WINDOW_MS),
          $lte: new Date(purchasedAt.getTime() + LEGACY_WINDOW_MS),
        },
      }).lean();
      if (legacy) { skip(`possibly already applied (older record ${legacy._id}) -- check by hand`); continue; }

      rows.push({ ...row, status: 'apply', plan });
    }
  }
  return rows;
}

/** Applies the rows marked 'apply'. Returns them with a result each. */
export async function applyRecoverable(rows) {
  const results = [];
  for (const row of rows.filter(r => r.status === 'apply')) {
    try {
      const { purchase, hashpowerAdded } = await grantPlanPurchase({
        userId: row.userId,
        plan: row.plan,
        productIdentifier: row.product,
        verified: { transactionId: row.transactionId, purchasedAt: row.purchasedAt },
        // RevenueCat's price when it reports one, else the plan's list price.
        pricePaid: row.price ?? row.plan.plan_cost,
        currency: row.currency ?? 'USD',
        revenuecatCustomerId: row.rcId,
      });
      results.push({ ...row, result: 'applied', purchaseId: purchase._id.toString(), hashpowerAdded });
    } catch (err) {
      const result = err?.code === 11000 ? 'already applied (concurrent)' : `failed: ${err.message}`;
      results.push({ ...row, result });
    }
  }
  return results;
}
