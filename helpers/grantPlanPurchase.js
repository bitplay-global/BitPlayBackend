/**
 * Records a verified plan purchase and adds its hashpower, atomically.
 *
 * Shared by POST /api/purchases/:userId and scripts/recover-purchases.js so a
 * recovered purchase is credited exactly as a live one would have been. The
 * caller must already have confirmed the purchase with RevenueCat.
 *
 * The unique index on store_transaction_id is the final guard against applying
 * one store transaction twice: a duplicate aborts the whole transaction.
 *
 * A subscription purchase also gets a SubscriptionGrant, so its hashpower lasts
 * as long as the subscription is paid (helpers/subscriptionGrants.js). Its
 * unique (customer, subscription) index means a second purchase report for a
 * subscription already tracked aborts here too; callers sync it instead.
 */
import mongoose from 'mongoose';
import Purchase from '../models/Purchase.js';
import UserMiningDetail from '../models/UserMiningDetails.js';
import SubscriptionGrant from '../models/SubscriptionGrant.js';

// Bonus percentage per plan, on top of the 2x base. A plan's own bonus_percent
// wins when set; this map covers plans created before that field existed.
const EXTRA_PERCENT = {
  '6929dcb949e964d72c41fab1': 35,
  '692a89b9a6ff597e727676a5': 5,
  '692a8aa5a6ff597e727676a8': 10,
  '692a8c32a6ff597e727676ab': 15,
  '692aa830a6ff597e727676b5': 25,
  '692aa933a6ff597e727676b7': 40,
  '692aaa54a6ff597e727676b9': 45,
};

export function hashpowerForPlan(plan) {
  const own = Number(plan.bonus_percent);
  const extraPercent = plan.bonus_percent != null && Number.isFinite(own) && own >= 0
    ? own
    : (EXTRA_PERCENT[plan._id?.toString()] ?? 0);
  const baseHash = plan.hashrate * 2;
  return baseHash + baseHash * (extraPercent / 100);
}

export async function grantPlanPurchase({
  userId, plan, productIdentifier, verified, pricePaid, currency, revenuecatCustomerId,
}) {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();

    let userMining = await UserMiningDetail.findOne({ user: userId }).session(session);
    const existingHashPower = userMining ? userMining.hashpower : 0;
    const hashpowerToAdd = hashpowerForPlan(plan);
    const updatedHashPower = existingHashPower + hashpowerToAdd;

    console.log(`Hashpower update: ${existingHashPower} -> ${updatedHashPower}`);

    const purchase = new Purchase({
      user: userId,
      plan_id: plan._id,
      product_identifier: productIdentifier,
      revenuecat_customer_id: revenuecatCustomerId || null,
      store_transaction_id: verified.transactionId,
      // Reporting only: this is what the client says it paid.
      price_paid: pricePaid,
      currency,
      // RevenueCat's timestamp, not the client's.
      purchase_date: verified.purchasedAt,
      status: 'completed',
      existing_hashpower: existingHashPower,
      updated_hashpower: updatedHashPower,
      mining_power_added: false,
    });

    await purchase.save({ session });
    console.log('Purchase saved:', purchase._id);

    if (verified.kind === 'subscription' && verified.rcKey && revenuecatCustomerId) {
      const e = verified.entry || {};
      const ends = [e.expires_date, e.grace_period_expires_date].filter(Boolean).map(d => new Date(d).getTime());
      const expiresAt = ends.length ? new Date(Math.max(...ends)) : null;
      await SubscriptionGrant.create([{
        user: userId,
        plan_id: plan._id,
        product_identifier: productIdentifier,
        rc_customer_id: revenuecatCustomerId,
        rc_key: verified.rcKey,
        purchase_id: purchase._id,
        hashpower: hashpowerToAdd,
        legacy: false,
        active: true,
        expires_at: expiresAt,
        period_purchase_date: verified.purchasedAt,
        history: [{ change: 'on', hashpower: hashpowerToAdd, purchase_date: verified.purchasedAt, expires_at: expiresAt, reason: 'purchased' }],
      }], { session });
    }

    if (!userMining) {
      userMining = new UserMiningDetail({
        user: userId,
        hashpower: hashpowerToAdd,
        claimedHashpower: 0,
        purchasedHashpower: hashpowerToAdd, // Set purchased hashpower (2x)
        rewarded_ads_watched: 0,
        thirty_gh_rewarded_ads_watched: 0,
        random_ads_watched: 0,
        mining_isactive: false,
        start_time: null,
        stop_time: null,
        local_start_time: null,
        local_stop_time: null,
        offset: null,
      });
      console.log('Created new mining details for user:', userId);
    } else {
      // Add hashrate to existing mining power (2x multiplier: users get double the purchased hashpower)
      const existingClaimed = userMining.claimedHashpower || 0;
      const existingPurchased = userMining.purchasedHashpower || 0;

      userMining.purchasedHashpower = existingPurchased + hashpowerToAdd;
      userMining.hashpower = updatedHashPower; // Total = claimed + purchased

      // Migration: Initialize missing fields for old users
      if (!userMining.lossTracking || !userMining.lossTracking.last_check_date) {
        console.log(`Migrating lossTracking for user ${userId} during purchase`);
        userMining.lossTracking = {
          daily_ads_watched: 0,
          cumulative_loss: 0,
          daily_loss_offset: 3.0,
          daily_ads_required: 10,
          last_check_date: new Date(),
        };
      }

      console.log(`Updated mining power for user ${userId}: claimed=${existingClaimed}, purchased=${userMining.purchasedHashpower}, total=${userMining.hashpower}`);
    }

    await userMining.save({ session });

    purchase.mining_power_added = true;
    await purchase.save({ session });

    await session.commitTransaction();
    return { purchase, existingHashPower, updatedHashPower, hashpowerAdded: hashpowerToAdd };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}
