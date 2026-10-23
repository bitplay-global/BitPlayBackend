/**
 * Automatic account suspension for abuse, and the gate that enforces it.
 *
 * Asked for on 2026-10-23 after three accounts fired thousands of scripted
 * reward-claim requests in a day (all refused by the rate limit, but still
 * a script, not a person), and after the 18-21 Oct scanner.
 *
 * Strikes are counted per user id (the account the request names, or the
 * verified token user) in a rolling one-hour window:
 *
 *   kind          what                                  suspend when
 *   rate_limit    a 429 from middleware/rateLimit.js    >= RATE_LIMIT_STRIKES_PER_HOUR (300)
 *   injection     a refused MongoDB-operator request    1st time
 *   xss           HTML/script tags in a text field      1st time
 *
 * Suspending sets users.status = "suspended", isActive = false and records
 * `suspension` {reason, kind, count, at, sample}. From then on:
 *   - every /api request naming that user gets 403 ACCOUNT_SUSPENDED
 *     (suspendedUserGuard; works with or without a token),
 *   - the auth service refuses login (checked there),
 *   - tokens are refused by appUserAuth (isActive false).
 * An admin reactivates from the dashboard Users page (status -> active);
 * the gate picks it up within CACHE_TTL_MS. ABUSE_AUTO_SUSPEND=off keeps the
 * counting and logging but stops automatic suspension.
 */
import mongoose from "mongoose";
import { _internals } from "../middleware/appUserAuth.js";

const WINDOW_MS = 60 * 60 * 1000;
const CACHE_TTL_MS = 60 * 1000;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const THRESHOLDS = {
  rate_limit: () => Number(process.env.ABUSE_RATE_LIMIT_STRIKES_PER_HOUR) || 300,
  injection: () => 1,
  xss: () => 1,
};
const autoSuspendOn = () => String(process.env.ABUSE_AUTO_SUSPEND || "on").toLowerCase() !== "off";

// userId -> { kind -> { start, count, sample } }
const strikes = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [u, kinds] of strikes) {
    for (const [k, b] of Object.entries(kinds)) if (now - b.start > WINDOW_MS) delete kinds[k];
    if (!Object.keys(kinds).length) strikes.delete(u);
  }
}, 60_000).unref();

// Suspended-id cache, refreshed from the database.
let suspended = new Set();
let cacheAt = 0;
let refreshing = null;
export async function refreshSuspendedCache() {
  const rows = await mongoose.connection.collection("users")
    .find({ isActive: false }, { projection: { _id: 1 } }).toArray();
  suspended = new Set(rows.map(r => String(r._id).toLowerCase()));
  cacheAt = Date.now();
  return suspended;
}
function cacheFresh() {
  if (Date.now() - cacheAt > CACHE_TTL_MS && !refreshing && mongoose.connection.readyState === 1) {
    refreshing = refreshSuspendedCache().catch(() => {}).finally(() => { refreshing = null; });
  }
}
export function isSuspended(userId) {
  cacheFresh();
  return suspended.has(String(userId || "").toLowerCase());
}

/** The user a request is about: the token user, else the id it names. */
export function requestUserId(req) {
  const id = req.authUserId || _internals.claimedUserIds(req)[0];
  return id && OBJECT_ID.test(id) ? id.toLowerCase() : null;
}

export async function suspendUser(userId, { kind, reason, count, sample }) {
  const users = mongoose.connection.collection("users");
  const r = await users.updateOne(
    { _id: new mongoose.Types.ObjectId(userId), isActive: { $ne: false } },
    { $set: { status: "suspended", isActive: false, suspension: { kind, reason, count: count ?? null, sample: String(sample || "").slice(0, 300), at: new Date(), by: "abuse-guard" } } },
  );
  if (r.modifiedCount) {
    suspended.add(userId.toLowerCase());
    console.warn(`[AbuseGuard] SUSPENDED user ${userId}: ${reason}`);
  }
  return r.modifiedCount > 0;
}

/**
 * Count a strike; suspend when the kind's threshold is reached.
 * Never throws; returns true when a suspension was made.
 */
export async function recordStrike(userId, kind, sample = "") {
  try {
    if (!userId || !OBJECT_ID.test(userId) || !THRESHOLDS[kind]) return false;
    const id = userId.toLowerCase();
    const kinds = strikes.get(id) || {};
    const now = Date.now();
    let b = kinds[kind];
    if (!b || now - b.start > WINDOW_MS) b = kinds[kind] = { start: now, count: 0, sample: "" };
    b.count += 1;
    if (!b.sample && sample) b.sample = String(sample).slice(0, 300);
    strikes.set(id, kinds);
    const limit = THRESHOLDS[kind]();
    if (b.count === limit) {
      console.warn(`[AbuseGuard] user ${id} reached ${b.count} ${kind} strikes in an hour (${sample ? String(sample).slice(0, 120) : "no sample"})`);
    }
    if (b.count < limit || !autoSuspendOn() || suspended.has(id)) return false;
    const reason = kind === "rate_limit"
      ? `automated request flood: ${b.count} rate-limited requests within an hour`
      : kind === "injection" ? "database query injection attempt" : "script/HTML injection attempt";
    return await suspendUser(id, { kind, reason, count: b.count, sample: b.sample || sample });
  } catch (err) {
    console.error("[AbuseGuard] recordStrike failed:", err?.message ?? err);
    return false;
  }
}

/** Text that is trying to be HTML/JavaScript rather than a name or message. */
const XSS = /<\s*\/?\s*(script|img|svg|iframe|object|embed|link|meta|style|form|input|body|video|audio|math)\b|\bon(error|load|click|mouse\w*|focus|blur|key\w*|submit|change|input|animation\w*|toggle)\s*=|javascript\s*:|vbscript\s*:|<\s*\w+[^>]*\bsrcdoc\s*=/i;
export function findXss(value, depth = 0, path = "") {
  if (depth > 10 || value == null) return null;
  if (typeof value === "string") return XSS.test(value) ? { path, value: value.slice(0, 200) } : null;
  if (typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value)) {
    const hit = findXss(v, depth + 1, path ? `${path}.${k}` : k);
    if (hit) return hit;
  }
  return null;
}

/**
 * Express middleware for /api: refuses suspended accounts, and refuses (and
 * strikes) requests whose text fields carry HTML/script.
 */
export function suspendedUserGuard(req, res, next) {
  if (req.session?.isLoggedIn) return next(); // admin dashboard
  const userId = requestUserId(req);
  if (userId && isSuspended(userId)) {
    return res.status(403).json({ success: false, code: "ACCOUNT_SUSPENDED", message: "This account has been suspended. Please contact support." });
  }
  const hit = findXss(req.body);
  if (hit) {
    console.warn(`[AbuseGuard] refused script injection on ${req.method} ${req.originalUrl.slice(0, 120)} field "${hit.path}" from ${req.ip}${userId ? ` user ${userId}` : ""}`);
    if (userId) recordStrike(userId, "xss", `${req.method} ${req.originalUrl.slice(0, 80)} ${hit.path}=${hit.value}`);
    return res.status(400).json({ success: false, code: "INVALID_INPUT", message: "Invalid characters in input." });
  }
  next();
}

export const _test = { strikes, THRESHOLDS, WINDOW_MS };
