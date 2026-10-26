// models/BonusGrant.js
//
// Hashpower given for a fixed time, not tied to a store subscription: on from
// starts_at, taken off again at expires_at by helpers/bonusGrants.js. `active`
// is the record of whether its hashpower is currently counted in the user's
// purchasedHashpower, so it is only ever flipped together with it.
//
// key is unique, so the same credit can never be given twice (e.g. the
// goodwill credit for pack renewals charged before 2026-10-26 is
// "past-renewals:<RevenueCat customer>:<subscription key>").
import mongoose from 'mongoose';

const BonusGrantSchema = new mongoose.Schema({
  key: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'users', required: true, index: true },
  hashpower: { type: Number, required: true, min: 0 },
  starts_at: { type: Date, required: true },
  expires_at: { type: Date, required: true },
  active: { type: Boolean, default: false },
  reason: { type: String, default: '' },
  ended_at: { type: Date, default: null },
}, { timestamps: true });

BonusGrantSchema.index({ key: 1 }, { unique: true });
BonusGrantSchema.index({ active: 1, expires_at: 1 });

export default mongoose.models.BonusGrant || mongoose.model('BonusGrant', BonusGrantSchema);
