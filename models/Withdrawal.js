import mongoose from "mongoose";
import { v4 as uuidv4 } from "uuid";

const withdrawalSchema = new mongoose.Schema({
  _id: {
    type: String,
    default: uuidv4,
  },
  userId: {
    type: String,
    ref: "User",
    required: true,
  },
  firebase_uid: {
    type: String,
    ref: 'User',
    index: true
  },
  asset: {
    type: String,
    required: true,
  },
  chain: {
    type: String,
    enum: ["BTC", "USDT", "USDC", "LTC", "BANK"],
    default: "NONE",
  },
  toAddress: {
    type: String,
    required: true,
  },
  defaultAmountNumeric: {
    type: mongoose.Schema.Types.Decimal128,
    required: false,
  },
  amountNumeric: {
    type: mongoose.Schema.Types.Decimal128,
    required: true,
  },
  status: {
    type: String,
    enum: ["PENDING", "APPROVED", "SENT", "CONFIRMED", "FAILED"],
    default: "PENDING",
  },
  txHash: {
    type: String,
    default: null
  },
  approvedBy: String,
  approvedAt: Date,
  action: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  mobileHeadersValid: {
    type: Boolean,
    default: false,
  },
  mobileAccessMeta: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  // Tracks whether BTC_DEPOSIT balance has already been reserved (deducted)
  // for this withdrawal, so /approve and /reject know whether a deduction
  // or refund is still owed. Was previously being set on create but wasn't
  // declared here, so Mongoose's default strict mode silently dropped it —
  // every record read it back as undefined regardless of what was written.
  balanceDeducted: {
    type: Boolean,
    default: false,
  },
}, { timestamps: { createdAt: "created_at", updatedAt: true } });

export default mongoose.model("Withdrawal", withdrawalSchema);
