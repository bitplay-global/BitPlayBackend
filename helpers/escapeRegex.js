/**
 * Escapes every regex metacharacter in a string so it can be embedded in a
 * MongoDB `$regex` safely.
 *
 * Without this, user-supplied values are interpreted as patterns rather than
 * literals: `GET /referrals?code=.*` matched every user in the collection, and
 * registering with a code of `.*` attached the account to an arbitrary parent.
 * Crafted patterns are also a denial-of-service vector through catastrophic
 * backtracking.
 *
 * Use for ANY value that reaches a $regex from a request.
 */
export function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default escapeRegex;
