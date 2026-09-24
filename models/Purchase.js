import mongoose from 'mongoose';

const PurchaseSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'users',
    required: true,
    index: true
  },
  plan_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SubscriptionPlan',
    required: true
  },
  // RevenueCat's store transaction id. Sparse-unique so one purchase grants
  // hashpower once; legacy rows without it are unaffected.
  store_transaction_id: {
    type: String,
  },
  product_identifier: {
    type: String,
    required: true
  },
  revenuecat_customer_id: {
    type: String,
    required: false
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
  status: {
    type: String,
    enum: ['completed', 'pending', 'failed', 'refunded'],
    default: 'completed'
  },
  existing_hashpower: {
    type: Number,
    required: true,
    min: 0
  },
  updated_hashpower: {
    type: Number,
    required: true,
    min: 0
  },
}, { timestamps: true });

// Index for querying user purchases
PurchaseSchema.index({ user: 1, purchase_date: -1 });
PurchaseSchema.index(
  { store_transaction_id: 1 },
  { unique: true, partialFilterExpression: { store_transaction_id: { $type: 'string' } } },
);

export default mongoose.model('Purchase', PurchaseSchema);
