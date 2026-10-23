/**
 * Refuses requests that try to smuggle MongoDB query operators.
 *
 * Express parses `?userId[$exists]=true` into { userId: { $exists: "true" } }.
 * Routes pass req.query / req.body values straight into find() and
 * aggregate($match), so such a value turns "this user's records" into "any
 * user's records". Seen in production 2026-10-18..21: an anonymous scanner
 * read other users' balance history via /api/wallet/history?userId[$exists]=true
 * and ?userId[$nin][]=...
 *
 * Rules:
 *  - query string values must be plain strings (or arrays of strings); any
 *    nested object is refused -- the app never sends one;
 *  - no key anywhere in the query or body may start with "$".
 * Everything else passes untouched.
 */
import { recordStrike, requestUserId } from "../helpers/abuseGuard.js";

const MAX_DEPTH = 20;

function hasOperatorKey(value, depth = 0) {
  if (depth > MAX_DEPTH || value == null || typeof value !== "object") return false;
  for (const key of Object.keys(value)) {
    // "$numberDecimal" is how Decimal128 amounts round-trip through JSON
    // (the app may send one back); it is a value format, not an operator.
    if (key.startsWith("$") && key !== "$numberDecimal") return true;
    if (hasOperatorKey(value[key], depth + 1)) return true;
  }
  return false;
}

function hasNestedQueryObject(query) {
  for (const v of Object.values(query || {})) {
    if (v == null || typeof v === "string") continue;
    if (Array.isArray(v) && v.every(x => typeof x === "string")) continue;
    return true;
  }
  return false;
}

export function noOperatorInjection(req, res, next) {
  if (hasNestedQueryObject(req.query) || hasOperatorKey(req.query) || hasOperatorKey(req.body)) {
    console.warn(`[Security] refused operator injection: ${req.method} ${req.originalUrl.slice(0, 200)} from ${req.ip}`);
    if (!req.session?.isLoggedIn) {
      const userId = requestUserId(req);
      if (userId) recordStrike(userId, "injection", `${req.method} ${req.originalUrl.slice(0, 120)}`);
    }
    return res.status(400).json({ success: false, error: "Invalid request." });
  }
  next();
}

export { hasOperatorKey, hasNestedQueryObject };
