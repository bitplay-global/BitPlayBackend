/**
 * Who is calling the app API?
 *
 * Until this existed, nothing here knew. The app sends only fixed headers baked
 * into the APK, and every route took `userId` from the URL or body on faith --
 * so any caller could read or change any user: overwrite a BTC balance, flip
 * 2FA, claim purchases, read withdrawal history.
 *
 * The auth service already issues the app a JWT at login. This middleware
 * verifies that token and makes the user it names the only user a request may
 * act as:
 *
 *   - a token that is present but invalid, expired, for an inactive account, or
 *     still waiting for its 2FA code is always refused
 *   - a valid token whose user differs from the userId the request claims is
 *     refused (403)
 *   - a request with NO token is refused only when ENFORCE_API_AUTH=true.
 *     Builds already installed don't send a token, so enforcing on day one
 *     would break every current user. Deploy with the flag off, ship the app
 *     update that sends the token, watch the "[AppAuth] unauthenticated" count
 *     fall, raise the minimum app version, then set ENFORCE_API_AUTH=true.
 *
 * Signed-in admin dashboard sessions are exempt: admins act on other users.
 *
 * Tokens are HS256 and verified with Node's crypto, so JWT_SECRET here must be
 * identical to the auth service's.
 */
import crypto from "crypto";
import mongoose from "mongoose";

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

// Routes that carry the acting user in the URL. Kept explicit rather than
// guessed, because other routes use 24-hex ids for tickets, plans and
// withdrawals, which are not users.
const USER_PATH_PATTERNS = [
  "/help/:userId",
  "/transactions/:userId",
  "/transactions/all/:userId",
  "/transactions/last7days/:userId",
  "/subscriptionplans/hashpower/:userId",
  "/withdrawals/user/:userId",
  "/notification-preferences/:userId",
  "/deposit-address/:userId/:asset",
  "/deposit-address/:userId",
  "/firebase_tokens/check/:userId",
  "/security/2fa-status/:userId",
  "/user_mining/:userId",
  "/user_mining/daily-progress/:userId",
  "/user_mining/trading-history/:userId",
  "/user_mining/spin-history/:userId",
  "/user_mining/memory-history/:userId",
  "/claim_daily_miner/:userId",
  "/purchases/:userId",
  "/privileges/:userId",
  "/mining-sessions/status/:userId",
].map(p => new RegExp("^" + p.replace(/:userId/, "([^/]+)").replace(/:\w+/g, "[^/]+") + "/?$"));

function claimedUserIds(req) {
  const ids = new Set();
  const add = v => { if (typeof v === "string" && OBJECT_ID.test(v)) ids.add(v.toLowerCase()); };

  // req.path is relative to the /api mount.
  for (const re of USER_PATH_PATTERNS) {
    const m = re.exec(req.path);
    if (m) { add(m[1]); break; }
  }
  const b = req.body && typeof req.body === "object" ? req.body : {};
  add(b.userId); add(b.user_id); add(b.user);
  if (b.metadata && typeof b.metadata === "object") add(b.metadata.user_id);
  add(req.query?.userId); add(req.query?.user_id);
  return [...ids];
}

function verifyHs256(token, secret) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  // Pin the algorithm; a token must not choose "none" or anything else.
  if (header.alg !== "HS256") return null;
  const expected = crypto.createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null;
  if (!payload.id) return null;
  return payload;
}

async function loadUser(id) {
  const users = mongoose.connection.collection("users");
  const idStr = String(id);
  const query = OBJECT_ID.test(idStr)
    ? { $or: [{ _id: new mongoose.Types.ObjectId(idStr) }, { _id: idStr }] }
    : { _id: idStr };
  return users.findOne(query, { projection: { isActive: 1, mfaVerifiedJtis: 1 } });
}

// Adoption signal, throttled so it can't flood the log.
let unauthCount = 0;
let unauthWindowStart = Date.now();
function noteUnauthenticated(path) {
  unauthCount += 1;
  if (Date.now() - unauthWindowStart >= 60_000) {
    console.warn(`[AppAuth] unauthenticated user-scoped requests in the last minute: ${unauthCount} (e.g. ${path})`);
    unauthCount = 0;
    unauthWindowStart = Date.now();
  }
}

const deny = (res, status, code, message) => res.status(status).json({ success: false, code, message });

export async function appUserAuth(req, res, next) {
  try {
    if (req.session?.isLoggedIn) return next(); // admin dashboard

    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const claimed = claimedUserIds(req);

    if (token) {
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        console.error("[AppAuth] JWT_SECRET is not set; cannot verify app tokens.");
        return deny(res, 503, "AUTH_UNAVAILABLE", "Authentication is not configured on the server.");
      }
      const payload = verifyHs256(token, secret);
      if (!payload) return deny(res, 401, "INVALID_TOKEN", "Your session has expired. Please sign in again.");

      const user = await loadUser(payload.id);
      if (!user || user.isActive === false) {
        return deny(res, 401, "INVALID_TOKEN", "Your session has expired. Please sign in again.");
      }
      // Same rule as the auth service: a 2FA login token is inert until its code.
      if (payload.mfa === "pending" && !(user.mfaVerifiedJtis || []).includes(payload.jti)) {
        return deny(res, 401, "MFA_REQUIRED", "Two-factor verification required.");
      }

      const authId = String(payload.id).toLowerCase();
      if (claimed.some(id => id !== authId)) {
        console.warn(`[AppAuth] user ${authId} tried to act as ${claimed.join(",")} on ${req.method} ${req.path}`);
        return deny(res, 403, "USER_MISMATCH", "You can only access your own account.");
      }
      req.authUserId = authId;
      return next();
    }

    if (claimed.length > 0) {
      if (process.env.ENFORCE_API_AUTH === "true") {
        return deny(res, 401, "AUTH_REQUIRED", "Please sign in again.");
      }
      noteUnauthenticated(`${req.method} ${req.path}`);
    }
    return next();
  } catch (err) {
    console.error("[AppAuth] error:", err.message);
    return deny(res, 500, "AUTH_ERROR", "Could not verify your session.");
  }
}

export const _internals = { claimedUserIds, verifyHs256, USER_PATH_PATTERNS };
