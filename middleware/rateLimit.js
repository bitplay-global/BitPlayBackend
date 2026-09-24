/**
 * Small in-memory rate limiter for abusable endpoints. No dependency.
 *
 * Keyed by the verified app user when a token was sent (req.authUserId, set by
 * appUserAuth), otherwise by client IP. Limits are deliberately generous and
 * applied only to sensitive routes: many mobile users sit behind one carrier
 * IP, so a tight global per-IP limit would lock out real people.
 *
 * Single-process memory: fine for one server behind nginx. If the service is
 * ever scaled out, move this to a shared store.
 */
const buckets = new Map();

// Drop expired windows periodically so memory stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) if (now - b.start > b.windowMs) buckets.delete(key);
}, 60_000).unref();

export function rateLimit({ name, windowMs, max }) {
  return (req, res, next) => {
    if (req.session?.isLoggedIn) return next(); // admin dashboard
    const who = req.authUserId ? `u:${req.authUserId}` : `ip:${req.ip}`;
    const key = `${name}|${who}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.start > windowMs) {
      b = { start: now, count: 0, windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      const retryAfter = Math.ceil((b.start + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      console.warn(`[RateLimit] ${name} exceeded by ${who}`);
      return res.status(429).json({ success: false, code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' });
    }
    return next();
  };
}
