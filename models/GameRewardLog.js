// models/GameRewardLog.js
//
// One row per mini-game reward the server actually granted (wins only: a lost
// round is never reported). Feeds the daily game streak, the weekly game
// leaderboard and the most-played games list (helpers/gameEngagement.js).
// `day` is the user's local day, the same day the reward limits use.
import mongoose from 'mongoose';

const GameRewardLogSchema = new mongoose.Schema({
  user: { type: String, required: true },
  gh: { type: Number, required: true, min: 0 },
  day: { type: String, required: true }, // YYYY-MM-DD, user's local day
  source: { type: String, default: 'game' }, // 'game' | 'trading'
  game: { type: String, default: '' }, // game name as the app's Game Zone lists it
  at: { type: Date, default: () => new Date() },
});

GameRewardLogSchema.index({ user: 1, day: -1 });
GameRewardLogSchema.index({ at: -1 });
GameRewardLogSchema.index({ game: 1, at: -1 });

export default mongoose.models.GameRewardLog || mongoose.model('GameRewardLog', GameRewardLogSchema);
