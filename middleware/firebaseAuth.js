import { getFirebaseAdmin } from '../config/firebase.js';

/**
 * Real per-user identity verification, built on the Firebase Admin SDK that's
 * already initialized in this project (see config/firebase.js, currently only
 * used for FCM push). Distinct from mobileAppGuard/requireWithdrawalAccess,
 * which only check headers that identify "the official app build" (app id,
 * platform, version, device id) — not the specific signed-in user making the
 * request.
 *
 * IMPORTANT — rollout status:
 * The current mobile app build does NOT send an Authorization header on its
 * API requests. That means this middleware runs in "soft" mode below: if no
 * token is present, the request is allowed through unchanged (so existing
 * users are not broken), and a warning is logged. It only starts REJECTING
 * traffic once a request actually presents a Bearer token that fails
 * verification or belongs to a different user than the one claimed in the
 * request body — which is either attacker traffic today (a legitimate
 * current app build never sends this header at all), or a client that has
 * upgraded to send tokens once available.
 *
 * NOT YET WIRED INTO ANY ROUTE. Before wiring requireOwnUser onto withdrawal
 * (or any) routes, confirm that the `userId` values used throughout this
 * codebase (Balance.user, Withdrawal.userId, the raw `users` collection's
 * `_id`) are actually Firebase UIDs, and not a separate internal ID — the
 * Balance/Withdrawal schemas have BOTH a `user`/`userId` string field and a
 * separate `firebase_uid` field, which is not proof either way. Wiring
 * identity-matching in blind risks rejecting every genuine user the moment
 * it activates.
 *
 * To fully close the impersonation gap:
 *   1. Confirm the userId/Firebase-UID relationship above.
 *   2. Ship a mobile app update that, after Firebase sign-in, attaches
 *      `Authorization: Bearer <firebase ID token>` to every API request.
 *   3. Once traffic is confirmed to be sending it, switch ENFORCE_FIREBASE_AUTH
 *      to require the header (see requireOwnUser below) instead of allowing
 *      missing-token requests through.
 */

const ENFORCE_FIREBASE_AUTH = process.env.ENFORCE_FIREBASE_AUTH === 'true';

/**
 * Verifies a Firebase ID token from the Authorization header, if present.
 * Always calls next() when no usable admin instance or no header is present
 * (soft mode) UNLESS ENFORCE_FIREBASE_AUTH=true, in which case a missing/
 * invalid token is rejected outright.
 *
 * On success, sets req.verifiedFirebaseUid to the verified Firebase uid.
 */
export const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);

  if (!match) {
    if (ENFORCE_FIREBASE_AUTH) {
      return res.status(401).json({ success: false, message: 'Missing Authorization token' });
    }
    console.warn(`[firebaseAuth] No Authorization header on ${req.method} ${req.originalUrl} — soft mode, allowing through`);
    return next();
  }

  const admin = getFirebaseAdmin();
  if (!admin) {
    console.error('[firebaseAuth] Firebase Admin SDK not initialized — cannot verify token');
    if (ENFORCE_FIREBASE_AUTH) {
      return res.status(503).json({ success: false, message: 'Auth verification temporarily unavailable' });
    }
    return next();
  }

  try {
    const decoded = await admin.auth().verifyIdToken(match[1]);
    req.verifiedFirebaseUid = decoded.uid;
    return next();
  } catch (err) {
    console.error('[firebaseAuth] Token verification failed:', err.message);
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

/**
 * Requires that the verified Firebase uid (from a valid Authorization header)
 * matches the user identity claimed in the request. Pass a function that
 * extracts the claimed userId from req (body/params/query vary per route).
 *
 * Must run AFTER verifyFirebaseToken. In soft mode (no ENFORCE_FIREBASE_AUTH),
 * a request with no verified uid is allowed through unchanged (current
 * behavior, since today's app build never sends a token) — but a request that
 * DID present a token is always required to match, since that can only be a
 * client attempting to assert who it is.
 */
export const requireOwnUser = (extractClaimedUserId) => (req, res, next) => {
  const claimedUserId = extractClaimedUserId(req);

  if (!req.verifiedFirebaseUid) {
    if (ENFORCE_FIREBASE_AUTH) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    return next(); // soft mode — no token presented, don't break current app traffic
  }

  if (!claimedUserId || claimedUserId !== req.verifiedFirebaseUid) {
    console.error(
      `[firebaseAuth] Identity mismatch: token uid=${req.verifiedFirebaseUid} but request claims userId=${claimedUserId} on ${req.method} ${req.originalUrl}`
    );
    return res.status(403).json({ success: false, message: 'Token does not match requested user' });
  }

  return next();
};
