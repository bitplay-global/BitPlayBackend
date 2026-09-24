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
}, { timestamps: { createdAt: "created_at" } });

export default mongoose.model("WalletAddress", walletAddressSchema);
