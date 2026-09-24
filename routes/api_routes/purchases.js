import express from 'express';
import Purchase from '../../models/Purchase.js';
import SubscriptionPlan from '../../models/SubscriptionPlan.js';
import { verifyStorePurchase } from '../../helpers/revenueCatVerify.js';
import { grantPlanPurchase } from '../../helpers/grantPlanPurchase.js';
import { matchPlanProduct } from '../../helpers/matchPlanProduct.js';

const router = express.Router();


// POST /api/purchases/:userId - Store purchase and update mining power
//
// The purchase is confirmed with RevenueCat before any hashpower is granted.
// This route used to grant plan.hashrate x2 (plus a bonus) on the client's word:
// a patched app or a plain request could mint mining power for free, and could
// pay for the cheapest product while naming the most expensive plan_id.
router.post('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const {
      plan_id,
      product_identifier,
      revenuecat_customer_id,
      price_paid,
      currency,
    } = req.body;

    // Validate required fields
    if (!userId || !plan_id || !product_identifier || !price_paid || !currency) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: userId, plan_id, product_identifier, price_paid, currency'
      });
    }

    // The product must be the one this plan sells (either store's id), or a
    // buyer could pay for a cheap product and claim an expensive plan.
    const plan = await SubscriptionPlan.findById(plan_id).lean();
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Subscription plan not found' });
    }
    const planProduct = matchPlanProduct(plan, product_identifier);
    if (!planProduct) {
      console.warn(`[Purchases] Rejected: product ${product_identifier} is not sold by plan ${plan_id} (user ${userId})`);
      return res.status(400).json({ success: false, message: 'That product does not match the selected plan.' });
    }

    // Ask RevenueCat whether the purchase happened. Fails closed. Verified
    // against the plan's own identifier, so a Google base plan is still checked
    // even when the app only reported the bare product id.
    let verified;
    try {
      verified = await verifyStorePurchase({ appUserId: revenuecat_customer_id, productIdentifier: planProduct });
    } catch (err) {
      console.warn(`[Purchases] Verification failed for user ${userId}, product ${product_identifier}: ${err.code || err.message}`);
      return res.status(err.status || 402).json({
        success: false,
        message: err.message || 'Purchase could not be verified.',
        code: err.code || 'VERIFICATION_FAILED'
      });
    }

    // One store transaction grants hashpower once, however often it is replayed.
    if (await Purchase.findOne({ store_transaction_id: verified.transactionId }).lean()) {
      return res.status(409).json({
        success: false,
        message: 'This purchase has already been applied.',
        code: 'TRANSACTION_ALREADY_USED'
      });
    }

    console.log('Found plan:', plan.name, 'Hashrate:', plan.hashrate, plan.unit);

    const { purchase, existingHashPower, updatedHashPower } = await grantPlanPurchase({
      userId,
      plan,
      productIdentifier: product_identifier,
      verified,
      pricePaid: price_paid,
      currency,
      revenuecatCustomerId: revenuecat_customer_id,
    });

    return res.status(200).json({
      success: true,
      message: 'Purchase recorded and mining power updated successfully',
      purchase: {
        id: purchase._id,
        plan_name: plan.name,
        hashrate: plan.hashrate,
        unit: plan.unit,
        duration: plan.duration,
        price_paid: purchase.price_paid,
        currency: purchase.currency,
        purchase_date: purchase.purchase_date,
        existing_hashpower: existingHashPower,
        updated_hashpower: updatedHashPower
      }
    });

  } catch (error) {
    if (error?.code === 11000) {
      // Two requests raced with the same transaction; the index kept one.
      return res.status(409).json({
        success: false,
        message: 'This purchase has already been applied.',
        code: 'TRANSACTION_ALREADY_USED'
      });
    }
    console.error('Error processing purchase:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to process purchase',
      error: error.message
    });
  }
});

// GET /api/purchases/:userId - Get user's purchase history
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const purchases = await Purchase.find({ user: userId })
      .populate('plan_id')
      .sort({ purchase_date: -1 })
      .select('-__v');

    return res.status(200).json({
      success: true,
      count: purchases.length,
      purchases
    });

  } catch (error) {
    console.error('Error fetching purchases:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch purchases',
      error: error.message
    });
  }
});

export default router;