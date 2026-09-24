import mongoose from "mongoose";

const balanceHistorySchema = new mongoose.Schema({
  user: { type: String, ref: "users", required: true, index: true},
  firebase_uid: {
    type: String,
    ref: 'users',
    index: true
  },
  date: { type: Date, required: true },
  balances: {
    BNB: { type: mongoose.Schema.Types.Decimal128, default: 0 },
    USDT: { type: mongoose.Schema.Types.Decimal128, default: 0 },
    USDC: { type: mongoose.Schema.Types.Decimal128, default: 0 },
    BTC: { type: mongoose.Schema.Types.Decimal128, default: 0 },
    LTC: { type: mongoose.Schema.Types.Decimal128, default: 0 },
  }
}, { timestamps: true });

// Create compound index for user and date to allow multiple records per user
balanceHistorySchema.index({ user: 1, date: -1 });

export default mongoose.model("BalanceHistory", balanceHistorySchema);
