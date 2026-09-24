// models/SubscriptionPlan.js
import mongoose from 'mongoose';

const subscriptionPlanSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  id: {
    type: String,
    required: true,
    unique: true
  },
  hashrate: {
    type: Number,
    required: true
  },
  unit: {
    type: String,
    required: true,
    default: "GH/s"
  },
  duration: {
    type: Number, // in months
    required: true
  },
  apple_identifier: {type: String, default: null, required: false},
  google_identifier: {type: String, default: null, required: false},
  maintenance_cost: {
    type: Number,
    required: true
  },
  plan_cost: {
    type: Number,
    required: true
  }
});

const SubscriptionPlan = mongoose.models.SubscriptionPlan || mongoose.model('SubscriptionPlan', subscriptionPlanSchema);
export default SubscriptionPlan;
