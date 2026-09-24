// models/StuckSessionRecovery.js
//
// One row per mining session that got stuck active without local_start_time
// (Sep 2026: the hourly settlement skipped such sessions, so they were never
// credited or reset). The settlement wipes a session's hashpower when it
// finally resets it, so the stuck state is captured here first -- it is what
// scripts/compensate-stuck-sessions.js pays the missed days from.
import mongoose from 'mongoose';

const StuckSessionRecoverySchema = new mongoose.Schema({
  user: { type: String, required: true },
  startTime: { type: Number, required: true },   // the stuck session's start_time (ms)
  sessionDay: { type: String, required: true },   // its local day, YYYY-MM-DD
  timezone: { type: String, default: null },
  offset: { type: Number, default: null },
  hashpower: { type: Number, required: true },    // what the app showed while stuck (0 if unknown)
  // When the hashpower was wiped before it could be recorded: the user's own
  // average daily mining (BTC) over the days before they got stuck.
  dailyBtc: { type: Number, default: null },
  basisDays: { type: Number, default: null },
  source: { type: String, enum: ['settlement', 'snapshot', 'log'], required: true },
  capturedAt: { type: Date, default: Date.now },
  settledAt: { type: Date, default: null },       // when the settlement finally reset it
  settledDay: { type: String, default: null },    // local day of that reset, YYYY-MM-DD
  compensatedDays: { type: [String], default: [] },
  compensatedBtc: { type: Number, default: 0 },
  streakBefore: { type: Number, default: null },
  streakAfter: { type: Number, default: null },
}, { timestamps: true });

StuckSessionRecoverySchema.index({ user: 1, startTime: 1 }, { unique: true });

export default mongoose.models.StuckSessionRecovery
  || mongoose.model('StuckSessionRecovery', StuckSessionRecoverySchema);
