import mongoose from "mongoose";

const depositSchema = new mongoose.Schema(
  {
    user: {
      type: String,
      ref: "users",
      required: true,
    },
    firebase_uid: {
      type: String,
      ref: 'users',
      index: true
    },
    asset: {
      type: String,
      required: true,
    },
    chain: {
      type: String,
      required: true,
    },
    address: {
      type: String,
      required: true,
    },
    txHash: {
      type: String,
      required: true,
    },
    vout: {
      type: Number,
      required: true,
    },
    amountNumeric: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
    },
    confirmations: {
      type: Number,
      required: true,
    },
    credited: {
      type: Boolean,
      default: false,
    },
    creditedAt: {
      type: Date,
    },
    // Set by scripts/credit-btc-deposit.js --orphan when a confirmed deposit
    // can never be credited (owner account no longer exists). The watcher
    // stops re-checking it; the coins remain on the deposit address.
    orphaned: {
      type: Boolean,
      default: false,
    },
    reviewNote: {
      type: String,
    },
    reviewedAt: {
      type: Date,
    },

    // --- Sweeper fields ---
    swept: {
      type: Boolean,
      default: false,
    },
    sweptTx: {
      type: String,
      default: null,
    },
    sweptAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

depositSchema.index({ txHash: 1, vout: 1 }, { unique: true });

export default mongoose.model("Deposit", depositSchema);
