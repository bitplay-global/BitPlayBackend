// models/SubscriptionGrant.js
//
// One row per store subscription (RevenueCat customer + subscription key) whose
// hashpower follows the subscription: on while a paid period is running, off
// when it ends. helpers/subscriptionGrants.js keeps `active` and the user's
// purchasedHashpower in step; `active` is the record of whether this grant's
// hashpower is currently counted, so it is only ever flipped together with it.
//
// legacy: bought before monthly renewal was honoured (2026-10-26). The original
// purchase keeps its hashpower permanently (granted by grantPlanPurchase); this
// row adds the pack's hashpower again for each period renewed after
// LEGACY_RENEWALS_FROM. Non-legacy rows are the purchase itself.
import mongoose from 'mongoose';

const SubscriptionGrantSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
  plan_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SubscriptionPlan', required: true },
  product_identifier: { type: String, required: true },
  rc_customer_id: { type: String, required: true },
  rc_key: { type: String, required: true },          // key under subscriber.subscriptions
  purchase_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', default: null },
  hashpower: { type: Number, required: true, min: 0 },
  legacy: { type: Boolean, default: false },
  active: { type: Boolean, default: false },
  expires_at: { type: Date, default: null },          // end of the paid period (incl. store grace)
  period_purchase_date: { type: Date, default: null },// start of the latest paid period seen
  last_checked_at: { type: Date, default: null },
  history: [{
    _id: false,
    at: { type: Date, default: Date.now },
    change: { type: String, enum: ['on', 'off', 'extend'] },
    hashpower: Number,
    purchase_date: Date,
    expires_at: Date,
    reason: String,
  }],
}, { timestamps: true });

SubscriptionGrantSchema.index({ rc_customer_id: 1, rc_key: 1 }, { unique: true });
SubscriptionGrantSchema.index({ active: 1, expires_at: 1 });

export default mongoose.models.SubscriptionGrant || mongoose.model('SubscriptionGrant', SubscriptionGrantSchema);
