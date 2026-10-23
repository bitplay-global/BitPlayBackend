/**
 * Records which app version each user runs, and when they were last seen.
 *
 * Every app request carries x-app-platform and x-app-version (the version
 * name, e.g. "2.0.1"; newer builds also send x-app-build). The user is the id
 * the request names (same rule as appUserAuth). The user document gets
 * `app: { platform, version, build, lastSeenAt }`, written at most once per
 * 10 minutes per user so the login traffic costs nothing extra. Fire and
 * forget: never delays or fails a request.
 *
 * Read with scripts/app-version-report.js or the Users page.
 */
import mongoose from "mongoose";
import { _internals } from "./appUserAuth.js";

const WRITE_INTERVAL_MS = 10 * 60 * 1000;
const lastWrite = new Map(); // userId -> ms
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

function clean(v, max = 40) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function appVersionTracker(req, res, next) {
  try {
    const version = clean(req.get("x-app-version"));
    if (!version) return next();
    const userId = req.authUserId || _internals.claimedUserIds(req)[0];
    if (!userId || !OBJECT_ID.test(userId)) return next();
    const now = Date.now();
    const key = `${userId}|${version}`;
    if (now - (lastWrite.get(key) || 0) < WRITE_INTERVAL_MS) return next();
    lastWrite.set(key, now);
    if (lastWrite.size > 50000) lastWrite.clear();
    mongoose.connection.collection("users").updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { $set: { app: { platform: clean(req.get("x-app-platform"), 10) || null, version, build: clean(req.get("x-app-build"), 20) || null, lastSeenAt: new Date(now) } } },
    ).catch(() => {});
  } catch {
    // never block a request over bookkeeping
  }
  next();
}
