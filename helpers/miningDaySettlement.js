/**
 * Shared by cron hourly settlement and GET /api/user_mining/:userId
 * (day rollover) so both paths use identical calendar / elapsed / history logic.
 */

const MAX_MINING_DURATION_MS = 24 * 60 * 60 * 1000;
const BTC_PER_HASHPOWER_PER_SEC = 0.000000000000007;

/**
 * Current date (YYYY-MM-DD) in a user's timezone; falls back to offset if IANA is missing.
 * @param {string | null} userTimezone
 * @param {string | number} userOffset
 */
export function getUserLocalDateStr(userTimezone, userOffset) {
  try {
    if (userTimezone) {
      return new Date().toLocaleDateString("en-CA", { timeZone: userTimezone });
    }
  } catch {
    // invalid timezone string, fall through
  }

  const offsetMin = Number(userOffset) || 0;
  const localMs = Date.now() - offsetMin * 60 * 1000;
  const d = new Date(localMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

/** Parse DD/MM/YYYY prefix from local_start_time string → YYYY-MM-DD (en-CA) */
export function getSessionStartDateStrFromLocalStart(localStartTime) {
  if (!localStartTime || typeof localStartTime !== "string") return null;
  const m = localStartTime.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const dd = m[1];
  const mm = m[2];
  const yyyy = m[3];
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * First UTC ms of the calendar day after `startMs` in the given IANA timezone
 * (binary search). Used to cap mined time at local midnight.
 */
export function getFirstInstantOfNextCalendarDayInTz(startMs, timeZone) {
  try {
    const startDay = new Date(startMs).toLocaleDateString("en-CA", { timeZone });
    let lo = startMs + 1;
    let hi = startMs + 26 * 3600000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const day = new Date(mid).toLocaleDateString("en-CA", { timeZone });
      if (day !== startDay) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    return lo;
  } catch {
    return startMs + 24 * 3600000;
  }
}

/** Same as getFirstInstantOfNextCalendarDayInTz but using offset in minutes. */
export function getFirstInstantOfNextCalendarDayWithOffset(startMs, offsetMin) {
  const localMs = startMs - Number(offsetMin || 0) * 60 * 1000;
  const ld = new Date(localMs);
  const y = ld.getUTCFullYear();
  const m = ld.getUTCMonth();
  const d = ld.getUTCDate();
  const nextMidnightLocalAsUtc = Date.UTC(y, m, d + 1, 0, 0, 0, 0);
  return nextMidnightLocalAsUtc + Number(offsetMin || 0) * 60 * 1000;
}

/**
 * Mined amount for a settled session (day rolled over) — same formula as the hourly cron.
 * @param {object} p
 * @param {any} p.miningDetail
 * @param {string | null} p.userTz
 * @param {string | number} p.userOffset
 */
export function computeMinedBtcOnDayRollover(p) {
  const { miningDetail, userTz, userOffset } = p;
  if (!(miningDetail.hashpower > 0)) {
    return 0;
  }
  const effectiveHp =
    typeof miningDetail.getEffectiveHashpower === "function"
      ? miningDetail.getEffectiveHashpower()
      : miningDetail.hashpower || 0;
  const stockBonus = miningDetail.stockGameBonus || 0;
  const totalPower = effectiveHp + stockBonus;

  const startMs = Number(miningDetail.start_time);
  let endMs;
  if (userTz) {
    endMs = getFirstInstantOfNextCalendarDayInTz(startMs, userTz);
  } else {
    endMs = getFirstInstantOfNextCalendarDayWithOffset(startMs, userOffset);
  }
  const elapsedMs = Math.max(0, Math.min(endMs - startMs, MAX_MINING_DURATION_MS));
  const miningDurationSec = elapsedMs / 1000;
  return totalPower * BTC_PER_HASHPOWER_PER_SEC * miningDurationSec;
}

/**
 * @param {string} sessionStartDateStr - YYYY-MM-DD from getSessionStartDateStrFromLocalStart
 * @returns {Date} UTC date used for BalanceHistory (same as cron)
 */
export function getHistoryDateFromSessionStartStr(sessionStartDateStr) {
  const [hy, hm, hd] = sessionStartDateStr.split("-").map(Number);
  return new Date(Date.UTC(hy, hm - 1, hd));
}

/**
 * Local calendar date (YYYY-MM-DD) of an instant in the user's timezone, or by
 * offset (minutes, JS getTimezoneOffset sign: IST = -330) when no IANA zone.
 */
export function getLocalDateStrAt(ms, userTimezone, userOffset) {
  try {
    if (userTimezone) return new Date(ms).toLocaleDateString("en-CA", { timeZone: userTimezone });
  } catch {
    // invalid timezone string, fall through
  }
  const d = new Date(ms - (Number(userOffset) || 0) * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * The local day a mining session started on. Prefers local_start_time (what the
 * app sent); falls back to start_time in the user's zone. The fallback matters:
 * a session activated without local_start_time (the app still holding the
 * previous day's start after midnight) used to be skipped by the hourly
 * settlement forever -- never credited, never reset, ad cap and daily claim
 * stuck for days.
 */
export function resolveSessionStartDateStr(miningDetail) {
  const fromLocal = getSessionStartDateStrFromLocalStart(miningDetail.local_start_time);
  if (fromLocal) return fromLocal;
  const startMs = Number(miningDetail.start_time);
  if (!(startMs > 0)) return null;
  return getLocalDateStrAt(startMs, miningDetail.timezone || null, miningDetail.offset);
}

/**
 * The app's local-time format ("DD/MM/YYYY, hh:mm:ss AM"), produced on the
 * server for an instant in the user's timezone -- used when the app starts a
 * session without sending local_start_time.
 */
export function formatLocalStartTime(ms, userTimezone, userOffset) {
  let parts;
  try {
    if (userTimezone) {
      const f = new Intl.DateTimeFormat("en-GB", {
        timeZone: userTimezone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
      }).formatToParts(new Date(ms));
      const get = t => f.find(p => p.type === t)?.value;
      parts = { dd: get("day"), mm: get("month"), yyyy: get("year"), h: Number(get("hour")), mi: get("minute"), ss: get("second") };
    }
  } catch {
    parts = undefined;
  }
  if (!parts) {
    const d = new Date(ms - (Number(userOffset) || 0) * 60 * 1000);
    parts = {
      dd: String(d.getUTCDate()).padStart(2, "0"), mm: String(d.getUTCMonth() + 1).padStart(2, "0"), yyyy: String(d.getUTCFullYear()),
      h: d.getUTCHours(), mi: String(d.getUTCMinutes()).padStart(2, "0"), ss: String(d.getUTCSeconds()).padStart(2, "0"),
    };
  }
  const ampm = parts.h >= 12 ? "PM" : "AM";
  const h12 = parts.h % 12 === 0 ? 12 : parts.h % 12;
  return `${parts.dd}/${parts.mm}/${parts.yyyy}, ${String(h12).padStart(2, "0")}:${parts.mi}:${parts.ss} ${ampm}`;
}
