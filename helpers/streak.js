/**
 * Single source of truth for the daily-activity streak.
 *
 * Two routes advance the streak: the daily reward claim and the mining POST
 * (every ad / game reward). They used to each build a "today" string and
 * compare it to streakLastDate with exact string equality, which reset the
 * streak whenever the two disagreed about what day it was:
 *
 *   - the daily claim used the client's local date, the mining POST used the
 *     server's UTC date (it never receives the client's current time), so for
 *     a user 5.5h ahead of UTC any reward between 00:00 and 05:30 local saw a
 *     "future" streakLastDate, matched neither today nor yesterday, and reset
 *     the streak to 1;
 *   - a manual DB edit of streakDays that didn't also set streakLastDate was
 *     reset on the next claim.
 *
 * This module replaces that with day arithmetic on the client's local day:
 *   diff = today - streakLastDate (in whole days)
 *   diff <= 0  -> already counted (or the other path was ahead): no change
 *   diff == 1  -> consecutive: +1
 *   diff >= 2  -> a day was missed: reset to 1
 * A record with streakDays > 0 but no usable streakLastDate keeps its days
 * and is stamped with today, so manual corrections survive the next claim.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Format a Date's *local* calendar day as YYYY-MM-DD. */
export function toDayString(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The client's local calendar day, derived from the server clock and the
 * client's `getTimezoneOffset()` value (minutes, positive west of UTC).
 * Example: offset -330 (IST) at 2026-10-09T22:00Z -> "2026-10-10".
 */
export function dayStringFromOffset(offsetMinutes, now = new Date()) {
  const off = Number(offsetMinutes);
  if (!Number.isFinite(off)) return null;
  const local = new Date(now.getTime() - off * 60 * 1000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Parse the app's "DD/MM/YYYY, hh:mm:ss AM/PM" local time string
 * (formatMiningLocalTimeForApi on the client) to YYYY-MM-DD. Returns null
 * when the string is missing or malformed.
 */
export function dayStringFromLocalTime(localTime) {
  if (typeof localTime !== 'string') return null;
  const parts = localTime.match(/\d+/g);
  if (!parts || parts.length < 3) return null;
  const day = parseInt(parts[0], 10), month = parseInt(parts[1], 10), year = parseInt(parts[2], 10);
  if (!(year >= 2000 && month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** YYYY-MM-DD -> whole days since epoch (UTC), or null if malformed. */
export function dayNumber(dayStr) {
  const m = DATE_RE.exec(String(dayStr ?? '').trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? Math.round(t / DAY_MS) : null;
}

/**
 * Decide the new streak for a claim made on `todayStr`.
 *
 * @param {{streakDays?: number, streakLastDate?: string|null}} record
 * @param {string} todayStr YYYY-MM-DD of the claim, in the user's local day
 * @returns {{streakDays:number, streakLastDate:string, changed:boolean, reason:string}}
 */
export function computeStreak(record, todayStr) {
  const prevDays = Math.max(0, Number(record?.streakDays) || 0);
  const today = dayNumber(todayStr);
  if (today === null) {
    // Can't tell what day it is: leave the record exactly as it was.
    return { streakDays: prevDays, streakLastDate: record?.streakLastDate ?? null, changed: false, reason: 'invalid-today' };
  }
  const last = dayNumber(record?.streakLastDate);

  if (last === null) {
    // No usable last date. Keep a manually-set streak rather than wiping it.
    const days = prevDays > 0 ? prevDays : 1;
    return { streakDays: days, streakLastDate: todayStr, changed: true, reason: prevDays > 0 ? 'adopted' : 'start' };
  }

  const diff = today - last;
  if (diff <= 0) {
    // Same day, or another path already stamped a later local day.
    return { streakDays: prevDays, streakLastDate: record.streakLastDate, changed: false, reason: 'already-counted' };
  }
  if (diff === 1) {
    return { streakDays: prevDays + 1, streakLastDate: todayStr, changed: true, reason: 'consecutive' };
  }
  return { streakDays: 1, streakLastDate: todayStr, changed: true, reason: 'gap' };
}
