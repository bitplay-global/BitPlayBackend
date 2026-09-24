#!/usr/bin/env node
/**
 * BalanceHistory rows where balances.BTC > threshold (default 0.0009).
 *
 * Dry-run (default): prints document count, unique `user` / `firebase_uid`
 * counts, a JSON array of every matching BalanceHistory row (newest `date`
 * first), then sorted unique IDs.
 *
 * Writes (requires --apply plus exactly one of):
 *   --delete        remove matching BalanceHistory documents
 *   --zero-btc      set balances.BTC to 0
 *   --backfill-btc  set balances.BTC to 9.072e-8 (same as backfill script)
 *   --set-btc=X     set balances.BTC to decimal string X (e.g. 9.072e-8)
 *
 * Usage:
 *   node scripts/balance-history-btc-threshold.js
 *   node scripts/balance-history-btc-threshold.js --threshold=0.00001000
 *   node scripts/balance-history-btc-threshold.js --threshold=0.0009
 *   node scripts/balance-history-btc-threshold.js --apply --delete
 *   node scripts/balance-history-btc-threshold.js --apply --zero-btc
 *   node scripts/balance-history-btc-threshold.js --threshold=0.00001000 --apply --backfill-btc
 *
 * Requires MONGODB_URI in .env (see recalculate-btc-deposit.js).
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

import BalanceHistory from "../models/BalanceHistory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const MONGODB_URI =
  process.env.MONGODB_URI;

/** Same nominal BTC as helpers/mining backfill (~9.072e-8). */
const BACKFILL_BTC_STR = "0.00000009072";

function parseArgs() {
  const argv = process.argv.slice(2);
  let thresholdStr = "0.0009";
  let apply = false;
  let del = false;
  let zeroBtc = false;
  let backfillBtc = false;
  /** @type {string | null} */
  let setBtcStr = null;

  for (const a of argv) {
    if (a === "--apply") apply = true;
    else if (a === "--delete") del = true;
    else if (a === "--zero-btc") zeroBtc = true;
    else if (a === "--backfill-btc") backfillBtc = true;
    else if (a.startsWith("--set-btc=")) {
      setBtcStr = a.slice("--set-btc=".length).trim();
    } else if (a.startsWith("--threshold=")) {
      thresholdStr = a.slice("--threshold=".length).trim();
    }
  }

  const threshold = Number.parseFloat(thresholdStr);
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error(`Invalid --threshold: ${thresholdStr}`);
  }

  if (backfillBtc) {
    setBtcStr = BACKFILL_BTC_STR;
  }

  const writeModes =
    (del ? 1 : 0) + (zeroBtc ? 1 : 0) + (setBtcStr != null && setBtcStr !== "" ? 1 : 0);

  return { apply, del, zeroBtc, setBtcStr, writeModes, threshold, thresholdStr };
}

function dec128(s) {
  return mongoose.Types.Decimal128.fromString(String(s));
}

function filterGtBtc(thresholdDec) {
  return { "balances.BTC": { $gt: thresholdDec } };
}

/** @param {import("mongoose").Types.Decimal128 | null | undefined} v */
function decToStr(v) {
  if (v == null) return null;
  return typeof v.toString === "function" ? v.toString() : String(v);
}

/** @param {Record<string, unknown>} row - lean BalanceHistory doc */
function rowToPlain(row) {
  const b = row.balances && typeof row.balances === "object" ? row.balances : {};
  return {
    _id: row._id != null ? String(row._id) : null,
    user: row.user ?? null,
    firebase_uid: row.firebase_uid ?? null,
    date: row.date instanceof Date ? row.date.toISOString() : row.date,
    balances: {
      BTC: decToStr(/** @type {any} */ (b).BTC),
      BNB: decToStr(/** @type {any} */ (b).BNB),
      USDT: decToStr(/** @type {any} */ (b).USDT),
      USDC: decToStr(/** @type {any} */ (b).USDC),
      LTC: decToStr(/** @type {any} */ (b).LTC),
    },
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt:
      row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

async function main() {
  const { apply, del, zeroBtc, setBtcStr, writeModes, threshold, thresholdStr } =
    parseArgs();

  if (apply && writeModes !== 1) {
    console.error(
      "With --apply, pass exactly one of: --delete | --zero-btc | --backfill-btc | --set-btc=..."
    );
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log("Connected:", mongoose.connection.host);

  const thresholdDec = dec128(thresholdStr);
  const filter = filterGtBtc(thresholdDec);

  const [docCount, rawUserIds, rawFirebaseUids] = await Promise.all([
    BalanceHistory.countDocuments(filter),
    BalanceHistory.distinct("user", filter),
    BalanceHistory.distinct("firebase_uid", {
      ...filter,
      firebase_uid: { $exists: true, $nin: [null, ""] },
    }),
  ]);

  const userIds = [...new Set(rawUserIds.filter(Boolean))].sort();
  const firebaseUids = [...new Set(rawFirebaseUids.filter(Boolean))].sort();

  console.log(
    `\nThreshold: balances.BTC > ${thresholdStr} (${threshold})\n` +
      `Matching BalanceHistory documents: ${docCount}\n` +
      `Unique users (\`user\` field): ${userIds.length}\n` +
      `Unique firebase_uid (rows above threshold with firebase_uid set): ${firebaseUids.length}\n`
  );

  if (!apply && docCount > 0) {
    const rows = await BalanceHistory.find(filter)
      .sort({ date: -1 })
      .lean();
    console.log("\n--- All matching BalanceHistory rows (newest date first) ---\n");
    console.log(JSON.stringify(rows.map(rowToPlain), null, 2));
  }

  if (userIds.length > 0) {
    console.log("\nUser IDs (`user` field, affected rows above threshold):");
    for (const id of userIds) {
      console.log(id);
    }
  }

  if (firebaseUids.length > 0) {
    console.log("\nfirebase_uid values (distinct, matching rows above threshold):");
    for (const id of firebaseUids) {
      console.log(id);
    }
  }

  if (!apply) {
    console.log(
      "\nDry-run only. Re-run with --apply and one of: --delete | --zero-btc | --backfill-btc | --set-btc=..."
    );
    await mongoose.disconnect();
    return;
  }

  if (del) {
    const result = await BalanceHistory.deleteMany(filter);
    console.log(`\nDeleted ${result.deletedCount} BalanceHistory document(s).`);
    console.log(
      "User IDs whose BalanceHistory rows were deleted (unique list above)."
    );
  } else if (zeroBtc) {
    const zero = dec128("0");
    const result = await BalanceHistory.updateMany(filter, {
      $set: { "balances.BTC": zero },
    });
    console.log(
      `\nUpdated ${result.modifiedCount} document(s) (matched ${result.matchedCount}) — balances.BTC set to 0.`
    );
    console.log("User IDs touched (unique list above).");
  } else if (setBtcStr) {
    const btc = dec128(setBtcStr);
    const result = await BalanceHistory.updateMany(filter, {
      $set: { "balances.BTC": btc },
    });
    console.log(
      `\nUpdated ${result.modifiedCount} document(s) (matched ${result.matchedCount}) — balances.BTC set to ${setBtcStr}.`
    );
    console.log("User IDs touched (unique list above).");
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


// cd btc-mining-backend
// # Preview only — lists all affected user IDs
// node scripts/balance-history-btc-threshold.js

// # Actually delete matching BalanceHistory rows (user IDs are printed before the delete)
// node scripts/balance-history-btc-threshold.js --apply --delete

// # Or only zero BTC on those rows instead of deleting
// node scripts/balance-history-btc-threshold.js --apply --zero-btc
//
// # Set BTC to backfill amount (9.072e-8) on rows above --threshold
// node scripts/balance-history-btc-threshold.js --threshold=0.00001000 --apply --backfill-btc
//
// # Then recalc Balance.BTC_DEPOSIT from history (check, then apply):
// node scripts/recalculate-btc-deposit.js
// node scripts/recalculate-btc-deposit.js --apply