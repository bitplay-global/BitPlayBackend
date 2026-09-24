import express from 'express';
import { verifyNonSubscriptionPurchase } from '../../helpers/revenueCatVerify.js';
import AdMultiplierPrivilege from '../../models/AdMultiplierPrivilege.js';

const router = express.Router();

// Tier catalog — multiplier factor to add to the base 1x. Keep in sync with
// whatever apple_identifier/google_identifier are configured in the store.
const TIER_CATALOG = {
  '5000pct': {
    multiplier: 50,
    productIds: [
      'bitplay.super_privilege_5000pct',
      'com.bitplaypro.bitplaypro.super_privilegeplan_5000pct',
    ],
  },
  '10000pct': {
    multiplier: 100,
    productIds: [
      'bitplay.super_privilege_10000pct',
      'com.bitplaypro.bitplaypro.super_privilegeplan_10000pct',
    ],
  },
};

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// POST /api/privileges/:userId — record a completed privilege purchase.
//
// The purchase is confirmed with RevenueCat before anything is granted. This
// route previously took the client's word for it, which is how privileges were
// created that have no matching payment: a patched app, or a plain curl, could
// mint a +10000% ad multiplier for free and name its own price.
//
// price_paid and multiplier now come from the server's own catalog and from
// RevenueCat, never from the request body.
router.post('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const {
      tier,
      product_identifier,
      revenuecat_customer_id,
      price_paid,
      currency,
      purchase_date,
    } = req.body;

    if (!userId || !tier || !product_identifier || price_paid == null || !currency) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: userId, tier, product_identifier, price_paid, currency',
      });
    }

    const catalogEntry = TIER_CATALOG[tier];
    if (!catalogEntry) {
      return res.status(400).json({ success: false, message: `Unknown tier: ${tier}` });
    }

    // The product must be one this tier actually sells, or a caller could pay
    // for the cheap tier and claim the expensive one.
    if (!catalogEntry.productIds.includes(product_identifier)) {
      console.warn(
        `[Privileges] Rejected: product ${product_identifier} does not belong to tier ${tier} (user ${userId})`,
      );
      return res.status(400).json({
        success: false,
        message: 'That product does not match the requested tier.',
      });
    }

    // Ask RevenueCat whether this purchase actually happened. Fails closed.
    let verified;
    try {
      verified = await verifyNonSubscriptionPurchase({
        appUserId: revenuecat_customer_id,
        productIdentifier: product_identifier,
      });
    } catch (err) {
      console.warn(
        `[Privileges] Verification failed for user ${userId}, product ${product_identifier}: ${err.code || err.message}`,
      );
      return res.status(err.status || 402).json({
        success: false,
        message: err.message || 'Purchase could not be verified.',
        code: err.code || 'VERIFICATION_FAILED',
      });
    }

    // One store transaction grants one privilege, however often it is replayed.
    const alreadyGranted = await AdMultiplierPrivilege.findOne({
      store_transaction_id: verified.transactionId,
    });
    if (alreadyGranted) {
      return res.status(409).json({
        success: false,
        message: 'This purchase has already been applied.',
        code: 'TRANSACTION_ALREADY_USED',
      });
    }

    // Renewable model: block only if this tier is currently ACTIVE (non-expired).
    // Once it expires, the same tier can be purchased again — this is why the
    // store product is Consumable rather than Non-Consumable, and why the DB
    // index on {user, tier} is not unique (multiple historical/expired records
    // per user+tier are expected as renewals accumulate).
    const existingActive = await AdMultiplierPrivilege.findOne({
      user: userId,
      tier,
      status: 'completed',
      expires_at: { $gt: new Date() },
    });
    if (existingActive) {
      return res.status(409).json({
        success: false,
        message: 'This privilege tier is already active for this user',
        expires_at: existingActive.expires_at,
      });
    }

    // RevenueCat's timestamp, not the client's -- the client could backdate or
    // postdate to game the one-year expiry.
    const purchaseDate = verified.purchasedAt;
    const expiresAt = new Date(purchaseDate.getTime() + ONE_YEAR_MS);

    const privilege = await AdMultiplierPrivilege.create({
      user: userId,
      tier,
      multiplier: catalogEntry.multiplier,
      product_identifier,
      revenuecat_customer_id: revenuecat_customer_id || null,
      store_transaction_id: verified.transactionId,
      // Recorded for reporting only. It is what the client claims it paid, and
      // is not trusted for anything -- the grant is authorised by `verified`.
      price_paid,
      currency,
      purchase_date: purchaseDate,
      expires_at: expiresAt,
      status: 'completed',
    });

    const effectiveMultiplier = await AdMultiplierPrivilege.getEffectiveMultiplier(userId);

    return res.status(200).json({
      success: true,
      message: 'Privilege recorded',
      privilege,
      effective_multiplier: effectiveMultiplier,
    });
  } catch (error) {
    console.error('Error recording privilege purchase:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to record privilege purchase',
      error: error.message,
    });
  }
});

// GET /api/privileges/:userId — current effective multiplier + active privileges.
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const active = await AdMultiplierPrivilege.find({
      user: userId,
      status: 'completed',
      expires_at: { $gt: new Date() },
    })
      .sort({ purchase_date: -1 })
      .select('-__v');

    const effectiveMultiplier = await AdMultiplierPrivilege.getEffectiveMultiplier(userId);

    return res.status(200).json({
      success: true,
      effective_multiplier: effectiveMultiplier,
      privileges: active,
    });
  } catch (error) {
    console.error('Error fetching privileges:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch privileges',
      error: error.message,
    });
  }
});

export default router;
