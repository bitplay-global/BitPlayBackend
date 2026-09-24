import mongoose from 'mongoose';

/**
 * "Super Privileges" — consumable-IAP-purchased, time-limited multipliers on
 * the special ad-watch track's per-claim reward (BASE_HASHPOWER_PER_AD in
 * user-mining-handles.js). Multiple tiers stack; each is valid for 1 year and
 * renewable — a user can hold at most one ACTIVE (non-expired) record per
 * tier at a time (enforced in the purchase route), but multiple historical
 * records per user+tier are expected as renewals accumulate.
 */
const AdMultiplierPrivilegeSchema = new mongoose.Schema({
  user: {
    type: String,
    ref: 'users',
    required: true,
    index: true
  },
  tier: {
    type: String,
    enum: ['5000pct', '10000pct'],
    required: true
  },
  // Multiplier as a plain factor to add to the base 1x, e.g. 50 for +5000%.
  multiplier: {
    type: Number,
    required: true,
    min: 0
  },
  product_identifier: {
    type: String,
    required: true
  },
  revenuecat_customer_id: {
    type: String,
    required: false
  },
  /**
   * RevenueCat's id for the underlying store transaction. Unique for real ids only (partial index, so
   * legacy rows without one are unaffected): replaying the same purchase --
   * whether by a retry or by someone reusing another account's transaction --
   * can then only ever grant the privilege once.
   */
  store_transaction_id: {
    type: String,
  },
  price_paid: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true,
    default: 'USD'
  },
  purchase_date: {
    type: Date,
    required: true,
    default: Date.now
  },
  expires_at: {
    type: Date,
    required: true
  },
  status: {
    type: String,
    enum: ['completed', 'pending', 'failed', 'refunded'],
    default: 'completed'
  },
}, { timestamps: true });

// NOT unique — a user can have multiple historical records for the same tier
// (renewals after expiry). "Only one active copy per tier" is an application-
// level rule enforced in the purchase route, not a DB constraint.
AdMultiplierPrivilegeSchema.index({ user: 1, tier: 1 });
// Sparse: only rows that carry a verified transaction id are constrained, so
// the pre-verification records already in the collection stay valid.
AdMultiplierPrivilegeSchema.index(
  { store_transaction_id: 1 },
  { unique: true, partialFilterExpression: { store_transaction_id: { $type: 'string' } } },
);
AdMultiplierPrivilegeSchema.index({ user: 1, expires_at: 1 });

/**
 * Effective multiplier factor for a user (1 = no boost, e.g. 151 = +15000%).
 * Only counts completed, non-expired privileges. Computed on read — no cron needed.
 */
AdMultiplierPrivilegeSchema.statics.getEffectiveMultiplier = async function (userId) {
  const active = await this.find({
    user: userId,
    status: 'completed',
    expires_at: { $gt: new Date() },
  }).lean();
  const boost = active.reduce((sum, p) => sum + (p.multiplier || 0), 0);
  return 1 + boost;
};

export default mongoose.model('AdMultiplierPrivilege', AdMultiplierPrivilegeSchema);
