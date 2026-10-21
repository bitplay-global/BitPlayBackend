/**
 * Dates and times sent by the app are only believed when they are possible.
 *
 * The app sends its own clock (local_time "DD/MM/YYYY, hh:mm:ss AM/PM", a
 * timezone offset, an IANA timezone, start times). Those decide "today" for
 * streaks and daily limits. On 18 Oct 2026 a scanner sent dates in 2027-2037
 * and an offset of -525600 minutes (one year) and got 100- and 200-day
 * streaks for fake accounts; a real user's record also ended up with a 2037
 * streak date, which freezes their counters until then.
 *
 * Rule: a calendar day is plausible only if it is "today" in some real
 * timezone right now -- every timezone is between UTC-12 and UTC+14, so the
 * day must lie between the date at UTC-12 and the date at UTC+14. Any honest
 * phone in any timezone is inside that window. Anything outside is ignored
 * (never an error): the server then uses its own clock with the user's
 * stored offset, so a user with a wrong phone clock still gets their rewards
 * for the real day.
 */
const HOUR = 3600 * 1000;
/** JS getTimezoneOffset range: UTC+14 = -840, UTC-12 = +720. */
export const MIN_OFFSET = -840;
export const MAX_OFFSET = 720;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Earliest and latest calendar day that is "today" somewhere right now. */
export function plausibleDayRange(now = Date.now()) {
  return { min: isoDay(now - 12 * HOUR), max: isoDay(now + 14 * HOUR) };
}

export function isPlausibleDay(dayStr, now = Date.now()) {
  if (typeof dayStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) return false;
  const { min, max } = plausibleDayRange(now);
  return dayStr >= min && dayStr <= max;
}

export function isPlausibleOffset(offset) {
  const n = Number(offset);
  return offset !== null && offset !== "" && Number.isFinite(n) && n >= MIN_OFFSET && n <= MAX_OFFSET;
}

export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/** A start/stop timestamp (ms) from the app: not in the future, not ancient. */
export function isPlausibleTimestamp(ms, now = Date.now(), { maxAgeMs = 48 * HOUR, maxAheadMs = 2 * 60 * 1000 } = {}) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 && n <= now + maxAheadMs && n >= now - maxAgeMs;
}

/** "DD/MM/YYYY, hh:mm..." -> "YYYY-MM-DD", or null. */
export function dayFromLocalTime(localTime) {
  if (typeof localTime !== "string") return null;
  const p = localTime.match(/\d+/g);
  if (!p || p.length < 3) return null;
  const [d, m, y] = [Number(p[0]), Number(p[1]), Number(p[2])];
  if (!(y >= 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The user's local day computed on the server from an offset (minutes). */
export function dayFromOffset(offset, now = Date.now()) {
  if (!isPlausibleOffset(offset)) return null;
  return isoDay(now - Number(offset) * 60 * 1000);
}

/**
 * The user's "today" for streaks and daily limits. Sources, best first, each
 * used only when plausible:
 *   1. the app's current local_time,
 *   2. the offset it sends (server clock + offset),
 *   3. the offset stored on the user's record,
 *   4. local_start_time (only when a session starts right now),
 *   5. the server's UTC day.
 * @returns {{ day:string, source:string, ignored:string[] }}
 *   `ignored` lists client values that were refused, for logging.
 */
export function trustedDay({ local_time, offset, local_start_time, storedOffset } = {}, now = Date.now()) {
  const ignored = [];
  const fromLocal = dayFromLocalTime(local_time);
  if (fromLocal) {
    if (isPlausibleDay(fromLocal, now)) return { day: fromLocal, source: "local_time", ignored };
    ignored.push(`local_time ${fromLocal}`);
  }
  if (offset != null && offset !== "") {
    const d = dayFromOffset(offset, now);
    if (d) return { day: d, source: "offset", ignored };
    ignored.push(`offset ${offset}`);
  }
  const stored = dayFromOffset(storedOffset, now);
  if (stored) return { day: stored, source: "stored offset", ignored };
  const fromStart = dayFromLocalTime(local_start_time);
  if (fromStart) {
    if (isPlausibleDay(fromStart, now)) return { day: fromStart, source: "local_start_time", ignored };
    ignored.push(`local_start_time ${fromStart}`);
  }
  return { day: isoDay(now), source: "server UTC", ignored };
}

/** True when a stored day is in the future beyond any timezone (a frozen counter). */
export function isFutureDay(dayStr, now = Date.now()) {
  return typeof dayStr === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dayStr) && dayStr > plausibleDayRange(now).max;
}
