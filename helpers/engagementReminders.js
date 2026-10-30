/**
 * Push reminders that bring players back (cronJobs.js runs them):
 *
 *  - Game streak: hourly, to players whose local time is 20:00-20:59, who
 *    have a game streak running (a game reward yesterday) and no game reward
 *    yet today. "Your N-day game streak ends at midnight".
 *  - Leaderboard: Saturdays and Sundays at 15:00 UTC, to this week's top 20,
 *    with their rank and how far they are behind the next place.
 *
 * Each user gets each kind at most once per day (ReminderLog, unique on
 * user+kind+day). Opt-outs and dead tokens are handled by
 * sendBulkNotifications. "Mining stopped" already exists (settlement).
 */
import mongoose from 'mongoose';
import GameRewardLog from '../models/GameRewardLog.js';
import UserMiningDetail from '../models/UserMiningDetails.js';
import { sendBulkNotifications } from '../services/notificationService.js';
import { gameStreak, weeklyLeaderboard, cycleDay, GAME_STREAK_BONUS } from './gameEngagement.js';

const ReminderLogSchema = new mongoose.Schema({
  user: { type: String, required: true },
  kind: { type: String, required: true },
  day: { type: String, required: true },
  at: { type: Date, default: () => new Date() },
});
ReminderLogSchema.index({ user: 1, kind: 1, day: 1 }, { unique: true });
ReminderLogSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });
export const ReminderLog = mongoose.models.ReminderLog || mongoose.model('ReminderLog', ReminderLogSchema);

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Local date and hour for a user, from the IANA zone or the stored offset (minutes, JS sign). */
export function localClock(now, timezone, offset) {
  try {
    if (timezone) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
      }).formatToParts(now);
      const get = t => parts.find(p => p.type === t)?.value;
      return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
    }
  } catch { /* bad zone: fall back to the offset */ }
  const local = new Date(now.getTime() - (Number(offset) || 0) * 60000);
  return { day: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
}

/** Claims the (user, kind, day) slot; false when this reminder was already sent. */
async function claimSlot(user, kind, day) {
  try {
    await ReminderLog.create({ user: String(user), kind, day });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

/**
 * Users at local 20:00-20:59 with a game streak at risk. Returns what was
 * sent, for the log. `send` is injectable for tests.
 */
export async function sendStreakReminders({ now = new Date(), send = sendBulkNotifications } = {}) {
  const utcToday = now.toISOString().slice(0, 10);
  // Anyone with a game reward in the last 2 UTC days may have a running streak.
  const recent = await GameRewardLog.distinct('user', { day: { $gte: addDays(utcToday, -2) } });
  if (!recent.length) return { candidates: 0, sent: 0 };
  const clocks = await UserMiningDetail.find({ user: { $in: recent } }, { user: 1, timezone: 1, offset: 1 }).lean();

  const groups = new Map(); // streak days -> user ids
  for (const c of clocks) {
    const { day, hour } = localClock(now, c.timezone, c.offset);
    if (hour !== 20) continue;
    const s = await gameStreak(c.user, day);
    if (s.playedToday || s.streakDays < 1) continue;
    if (!(await claimSlot(c.user, 'game-streak', day))) continue;
    if (!groups.has(s.streakDays)) groups.set(s.streakDays, []);
    groups.get(s.streakDays).push(String(c.user));
  }

  let sent = 0;
  for (const [days, users] of groups) {
    // Playing today makes today streak day days+1; does that day pay?
    const bonus = GAME_STREAK_BONUS[cycleDay(days + 1)];
    const r = await send(users, {
      title: `🔥 Your ${days}-day game streak ends at midnight`,
      body: bonus
        ? `Win one game today to keep it — today pays a +${bonus} GH/s streak bonus!`
        : 'Win and claim one game today to keep your streak going.',
      data: { type: 'game_streak', screen: 'Games' },
    });
    sent += r?.sent || 0;
  }
  return { candidates: clocks.length, sent };
}

/** Weekend nudge to this week's top 20. */
export async function sendLeaderboardReminders({ now = new Date(), send = sendBulkNotifications } = {}) {
  const day = now.toISOString().slice(0, 10);
  const { rows } = await weeklyLeaderboard({ limit: 20, now });
  let sent = 0;
  for (const row of rows) {
    if (!(await claimSlot(row.userId, 'leaderboard', day))) continue;
    const ahead = rows[row.rank - 2];
    const gap = ahead ? Math.max(0.1, Math.round((ahead.gh - row.gh) * 10) / 10) : 0;
    const r = await send([row.userId], {
      title: row.rank === 1 ? '🏆 You are #1 this week!' : `🏆 You're #${row.rank} on this week's leaderboard`,
      body: row.rank === 1
        ? 'Keep playing to hold the top spot — the board resets Monday.'
        : `Just ${gap} GH/s behind #${row.rank - 1}. The board resets Monday — play now!`,
      data: { type: 'leaderboard', screen: 'Games' },
    });
    sent += r?.sent || 0;
  }
  return { players: rows.length, sent };
}
