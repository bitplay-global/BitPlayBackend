/**
 * Daily game streak and weekly game leaderboard.
 *
 * Both count game rewards the server granted (GameRewardLog), never what the
 * app says it played: a loss is not reported at all, and a win only counts
 * once the reward limits in helpers/rewardGrants.js have allowed it.
 *
 * Streak: a day counts when the user claims at least one game reward that
 * local day. Days 3, 5 and 7 of a run give bonus mining power for 24 hours
 * (BonusGrant, removed by the hourly cron); after day 7 the cycle starts
 * again, so day 10 pays like day 3. Each streak day can pay once.
 *
 * Leaderboard: GH/s claimed from games since Monday 00:00 UTC, top 20, names
 * shortened to "First L." -- never an email.
 */
import mongoose from 'mongoose';
import GameRewardLog from '../models/GameRewardLog.js';
import { grantBonus } from './bonusGrants.js';

export const GAME_STREAK_BONUS = { 3: 10, 5: 20, 7: 30 };
const CYCLE = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Consecutive days ending at `today` (or yesterday, if today has none yet). */
export function streakFromDays(days, today) {
  const set = new Set(days);
  let end = set.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (set.has(end)) { n += 1; end = addDays(end, -1); }
  return { days: n, playedToday: set.has(today) };
}

/** Position in the 7-day cycle (1..7) for a streak of `n` days. */
export const cycleDay = n => (n <= 0 ? 0 : ((n - 1) % CYCLE) + 1);

export async function gameStreak(userId, today) {
  const since = addDays(today, -(CYCLE * 5));
  const days = await GameRewardLog.distinct('day', { user: String(userId), day: { $gte: since, $lte: today } });
  const s = streakFromDays(days, today);
  const pos = cycleDay(s.days);
  const next = [3, 5, 7].find(d => d > pos) ?? 3;
  return {
    streakDays: s.days,
    playedToday: s.playedToday,
    cycleDay: pos,
    nextBonusDay: next,
    nextBonusGh: GAME_STREAK_BONUS[next],
    daysToNextBonus: next > pos ? next - pos : CYCLE - pos + next,
  };
}

/**
 * Records a granted game reward and pays the streak bonus when this reward
 * completes day 3, 5 or 7 of the cycle. Never throws: a logging problem must
 * not undo a reward the user already has.
 */
export async function recordGameReward({ userId, gh, day, source = 'game', game = '', now = new Date() }) {
  if (!(gh > 0) || !userId || !day) return null;
  try {
    const firstToday = !(await GameRewardLog.exists({ user: String(userId), day }));
    await GameRewardLog.create({ user: String(userId), gh, day, source, game: String(game || '').trim().slice(0, 40), at: now });
    if (!firstToday) return null;
    const s = await gameStreak(userId, day);
    const bonus = GAME_STREAK_BONUS[s.cycleDay];
    if (!bonus) return null;
    const r = await grantBonus({
      key: `gamestreak:${userId}:${day}`,
      userId,
      hashpower: bonus,
      expiresAt: new Date(now.getTime() + DAY_MS),
      reason: `game streak day ${s.streakDays} (cycle day ${s.cycleDay})`,
      now,
    });
    return r === 'granted' ? { bonusGh: bonus, streakDays: s.streakDays } : null;
  } catch (err) {
    console.warn(`[GameStreak] user ${userId}: ${err.message}`);
    return null;
  }
}

export function weekStart(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const back = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - back * DAY_MS);
}

/** "Sunil Bhandari" -> "Sunil B."; no name -> "Player 4a2f". Never an email. */
export function displayName(user) {
  const parts = String(user?.name || '').trim().split(/\s+/).filter(Boolean);
  const clean = s => s.replace(/[^\p{L}\p{N}'-]/gu, '').slice(0, 14);
  if (parts.length && !parts[0].includes('@')) {
    const first = clean(parts[0]);
    const last = parts.length > 1 ? clean(parts[parts.length - 1]).charAt(0) : '';
    if (first) return last ? `${first} ${last.toUpperCase()}.` : first;
  }
  return `Player ${String(user?._id || '').slice(-4)}`;
}

let popularCache = { at: 0, key: '', rows: [] };

/**
 * Most-played games: game wins claimed per game over the last `days` days.
 * Shaped for the app's Game Zone and Home ({ gameName, totalSessions }).
 * Wins stand in for plays because a lost round is never reported.
 */
export async function popularGames({ limit = 30, days = 30, now = new Date() } = {}) {
  const key = `${limit}:${days}`;
  if (popularCache.key === key && now - popularCache.at < 10 * 60 * 1000) return popularCache.rows;
  const rows = (await GameRewardLog.aggregate([
    { $match: { at: { $gte: new Date(now.getTime() - days * DAY_MS) }, game: { $nin: ['', null] } } },
    { $group: { _id: '$game', totalSessions: { $sum: 1 }, players: { $addToSet: '$user' } } },
    { $sort: { totalSessions: -1 } },
    { $limit: limit },
  ])).map(r => ({ gameName: r._id, totalSessions: r.totalSessions, players: r.players.length }));
  popularCache = { at: now.getTime(), key, rows };
  return rows;
}

let cache = { at: 0, week: 0, rows: [] };

/** Top `limit` players this week, refreshed at most every 5 minutes. */
export async function weeklyLeaderboard({ limit = 20, now = new Date() } = {}) {
  const start = weekStart(now);
  if (cache.week === start.getTime() && now - cache.at < 5 * 60 * 1000) return { weekStart: start, rows: cache.rows };
  const top = await GameRewardLog.aggregate([
    { $match: { at: { $gte: start } } },
    { $group: { _id: '$user', gh: { $sum: '$gh' }, wins: { $sum: 1 } } },
    { $sort: { gh: -1, wins: -1 } },
    { $limit: limit },
  ]);
  const ids = top.map(t => t._id).filter(id => mongoose.Types.ObjectId.isValid(id)).map(id => new mongoose.Types.ObjectId(id));
  const users = await mongoose.connection.collection('users')
    .find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray();
  const byId = new Map(users.map(u => [String(u._id), u]));
  const rows = top.map((t, i) => ({
    rank: i + 1,
    userId: t._id,
    name: displayName(byId.get(t._id) || { _id: t._id }),
    gh: Math.round(t.gh * 10) / 10,
    wins: t.wins,
  }));
  cache = { at: now.getTime(), week: start.getTime(), rows };
  return { weekStart: start, rows };
}

/** This user's GH/s and rank this week (rank among everyone, not only the top). */
export async function myWeek(userId, now = new Date()) {
  const start = weekStart(now);
  const [mine] = await GameRewardLog.aggregate([
    { $match: { user: String(userId), at: { $gte: start } } },
    { $group: { _id: null, gh: { $sum: '$gh' } } },
  ]);
  const gh = mine?.gh || 0;
  if (!gh) return { gh: 0, rank: null };
  const ahead = await GameRewardLog.aggregate([
    { $match: { at: { $gte: start } } },
    { $group: { _id: '$user', gh: { $sum: '$gh' } } },
    { $match: { gh: { $gt: gh } } },
    { $count: 'n' },
  ]);
  return { gh: Math.round(gh * 10) / 10, rank: (ahead[0]?.n || 0) + 1 };
}
