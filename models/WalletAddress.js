import mongoose from "mongoose";

const walletAddressSchema = new mongoose.Schema({
  userId: {
    type: String,
    ref: "User",
    required: true,
  },
  firebase_uid: {
    type: String,
    ref: 'users',
    index: true
  },
  chain: {
    type: String,
    enum: ["bsc", "btc", "ltc"],
    required: true,
  },
  asset: {
    type: String,
    enum: ["BNB", "USDT", "USDC", "BTC", "LTC"],
    required: true,
  },
  address: {
    type: String,
    required: true,
    unique: true,
  },
  derivationPath: {
    type: String,
  },
  idx: {
    type: Number,
    required: true,
  },
  // Legacy only. Private keys used to be stored here in plaintext (and returned
  // to the caller). New addresses store none: the key is derivable offline from
  // the account key and derivationPath. Existing values should be purged once
  // the funds have been moved to a new wallet.
  privateKey: {
    type: String,
    required: false,
    select: false
  },
  // Set when the address must no longer be handed out (e.g. it was derived
  // from a key that has since been replaced). The record is kept so the
  // watchers still attribute late deposits to it; the deposit route skips it
  // and issues a fresh address instead.
  retiredAt: {
    type: Date,
    default: null,
  },
  retiredReason: {
    type: String,
  },
}, { timestamps: { createdAt: "created_at" } });

export default mongoose.model("WalletAddress", walletAddressSchema);
