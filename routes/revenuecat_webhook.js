import express from 'express';
import crypto from 'crypto';
import Purchase from '../models/Purchase.js';
import SubscriptionPlan from '../models/SubscriptionPlan.js';
import { verifyStorePurchase } from '../helpers/revenueCatVerify.js';
import { grantPlanPurchase } from '../helpers/grantPlanPurchase.js';
import { matchPlanProduct } from '../helpers/matchPlanProduct.js';

const router = express.Router();

// Renewals are deliberately not handled: the app's own flow grants hashpower
// once per purchase, and this must not change what a purchase is worth.
const HANDLED_TYPES = new Set(['INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE']);
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
// Verification failures that are final: RevenueCat retrying would change nothing.
const FINAL_REFUSALS = new Set(['VERIFICATION_REFUNDED', 'VERIFICATION_SANDBOX_PURCHASE']);

function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

function resolveUserId(event) {
  const candidates = [
    event.subscriber_attributes?.bitplay_user_id?.value,
    event.app_user_id,
    event.original_app_user_id,
    ...(Array.isArray(event.aliases) ? event.aliases : []),
  ];
  return candidates.find((c) => typeof c === 'string' && OBJECT_ID.test(c)) || null;
}

async function resolvePlan(event) {
  const plans = await SubscriptionPlan.find({}).lean();
  for (const reported of [event.product_id, event.new_product_id]) {
    if (!reported) continue;
    for (const plan of plans) {
      const planProduct = matchPlanProduct(plan, reported);
      if (planProduct) return { plan, planProduct };
    }
  }
  return null;
}

// POST /webhooks/revenuecat
// Configure in RevenueCat: Project settings > Integrations > Webhooks, with the
// Authorization header value set to REVENUECAT_WEBHOOK_AUTH.
//
// This is the safety net for the app's own POST /api/purchases/:userId, which
// is a single call: if it failed or lost the race with RevenueCat's processing,
// the purchase was paid for but never recorded. The event only says WHICH
// purchase to look at; it is re-verified with RevenueCat exactly as the app's
// call is, so both paths derive the same transaction id and the unique index on
// store_transaction_id makes whichever arrives second a no-op.
router.post('/', async (req, res) => {
  const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (!expected) {
    console.error('[RevenueCat webhook] REVENUECAT_WEBHOOK_AUTH is not set; refusing all events.');
    return res.status(503).json({ success: false, message: 'Webhook not configured' });
  }
  const header = req.get('authorization') || '';
  if (!safeEqual(header, expected) && !safeEqual(header, `Bearer ${expected}`)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const event = req.body?.event;
  if (!event || !event.type) {
    return res.status(400).json({ success: false, message: 'Missing event' });
  }
  if (!HANDLED_TYPES.has(event.type)) {
    return res.status(200).json({ success: true, ignored: event.type });
  }

  try {
    const userId = resolveUserId(event);
    if (!userId) {
      // 200 so RevenueCat doesn't retry an event that can never be matched.
      console.warn(`[RevenueCat webhook] No app user id on ${event.type} ${event.transaction_id} (app_user_id=${event.app_user_id}, product=${event.product_id}). Grant manually or run scripts/recover-purchases.js if the buyer is known.`);
      return res.status(200).json({ success: true, unmatched: 'user' });
    }

    const match = await resolvePlan(event);
    if (!match) {
      console.warn(`[RevenueCat webhook] No plan matches product ${event.product_id} (${event.transaction_id}, user ${userId}).`);
      return res.status(200).json({ success: true, unmatched: 'plan' });
    }
    const { plan, planProduct } = match;

    let verified;
    try {
      verified = await verifyStorePurchase({
        appUserId: event.original_app_user_id || event.app_user_id,
        productIdentifier: planProduct,
      });
    } catch (err) {
      if (FINAL_REFUSALS.has(err.code)) {
        return res.status(200).json({ success: true, ignored: err.code });
      }
      console.warn(`[RevenueCat webhook] Could not verify ${event.transaction_id} for user ${userId}: ${err.code || err.message}`);
      // Non-2xx so RevenueCat retries; it usually just needs a moment.
      return res.status(500).json({ success: false, message: 'Verification failed', code: err.code });
    }

    if (await Purchase.findOne({ store_transaction_id: verified.transactionId }).lean()) {
      return res.status(200).json({ success: true, duplicate: true });
    }

    const hasLocalPrice = event.price_in_purchased_currency != null && event.currency;
    await grantPlanPurchase({
      userId,
      plan,
      productIdentifier: event.product_id,
      verified,
      pricePaid: Number(hasLocalPrice ? event.price_in_purchased_currency : event.price) || 0,
      currency: hasLocalPrice ? event.currency : 'USD',
      revenuecatCustomerId: event.original_app_user_id || event.app_user_id,
    });

    console.log(`[RevenueCat webhook] Recorded ${event.type} ${verified.transactionId} for user ${userId} (plan ${plan.name}).`);
    return res.status(200).json({ success: true, applied: true });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(200).json({ success: true, duplicate: true });
    }
    console.error('[RevenueCat webhook] Failed to process event:', err);
    return res.status(500).json({ success: false, message: 'Processing failed' });
  }
});

export default router;
