#!/usr/bin/env node
/**
 * Insert missing BalanceHistory rows for every user over a
 * UTC calendar-day range. For each user, days before their account creation
 * (Balance.createdAt, UTC date) are skipped — e.g. range 27 Apr–4 May 2026 but
 * user created 1 May 2026 → only 1–4 May rows are created.
 *
 * New rows: balances.BTC = 9.072e-8 (0.00000009072); other assets 0.
 * Existing (user, date) documents are left unchanged ($setOnInsert only).
 *
 * Usage:
 *   node scripts/backfill-balance-history-date-range.js
 *   node scripts/backfill-balance-history-date-range.js --from=2026-04-27 --to=2026-05-04
 *   node scripts/backfill-balance-history-date-range.js --apply
 *
 * Requires MONGODB_URI in .env (see other scripts).
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

import Balance from "../models/Balance.js";
import BalanceHistory from "../models/BalanceHistory.js";
import { getHistoryDateFromSessionStartStr } from "../helpers/miningDaySettlement.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const MONGODB_URI =
  process.env.MONGODB_URI;

const DEFAULT_FROM = "2026-04-27";
const DEFAULT_TO = "2026-05-04";

function dec128Zero() {
  return mongoose.Types.Decimal128.fromString("0");
}

/** BTC on each newly inserted history row (others stay 0). ~9.072e-8 */
const BACKFILL_BTC = mongoose.Types.Decimal128.fromString("0.00000009072");

/** @param {Date} d */
function startOfUtcCalendarDay(d) {
  const x = new Date(d);
  return new Date(
    Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())
  );
}

/**
 * @param {string} ymd - YYYY-MM-DD
 * @returns {Date}
 */
function parseUtcDay(ymd) {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid date (use YYYY-MM-DD): ${ymd}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return new Date(Date.UTC(y, mo - 1, d));
}

/**
 * Inclusive range of UTC calendar days as History dates (same as cron).
 * @param {Date} fromDay - UTC midnight
 * @param {Date} toDay - UTC midnight
 */
function historyDatesInclusive(fromDay, toDay) {
  const out = [];
  let t = fromDay.getTime();
  const end = toDay.getTime();
  while (t <= end) {
    const cur = new Date(t);
    const y = cur.getUTCFullYear();
    const mo = String(cur.getUTCMonth() + 1).padStart(2, "0");
    const d = String(cur.getUTCDate()).padStart(2, "0");
    out.push(getHistoryDateFromSessionStartStr(`${y}-${mo}-${d}`));
    t += 86400000;
  }
  return out;
}

/** @param {import("mongoose").Document} balanceDoc */
function balanceCreatedAt(balanceDoc) {
  if (balanceDoc.createdAt) return balanceDoc.createdAt;
  const id = balanceDoc._id;
  if (id && typeof id.getTimestamp === "function") return id.getTimestamp();
  return new Date(0);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let fromStr = DEFAULT_FROM;
  let toStr = DEFAULT_TO;
  let apply = false;

  for (const a of argv) {
    if (a === "--apply") apply = true;
    else if (a.startsWith("--from="))
      fromStr = a.slice("--from=".length).trim();
    else if (a.startsWith("--to=")) toStr = a.slice("--to=".length).trim();
  }

  return { apply, fromStr, toStr };
}

const INSERT_BALANCES = () => ({
  BNB: dec128Zero(),
  USDT: dec128Zero(),
  USDC: dec128Zero(),
  BTC: BACKFILL_BTC,
  LTC: dec128Zero(),
});

/**
 * @param {object} opts
 * @param {Date} opts.rangeStartDay - UTC midnight, first calendar day
 * @param {Date} opts.rangeEndDay - UTC midnight, last calendar day (inclusive)
 * @param {boolean} [opts.apply=false] - if false, only count would-be upserts
 * @param {number} [opts.bulkSize=500]
 * @returns {Promise<{ users: number, daysInRange: number, wouldInsert: number, inserted: number }>}
 */
export async function backfillBalanceHistoryDateRange(opts) {
  const {
    rangeStartDay,
    rangeEndDay,
    apply = false,
    bulkSize = 500,
  } = opts;

  const from = startOfUtcCalendarDay(rangeStartDay);
  const to = startOfUtcCalendarDay(rangeEndDay);
  if (from.getTime() > to.getTime()) {
    throw new Error("rangeStartDay must be <= rangeEndDay");
  }

  const allHistoryDates = historyDatesInclusive(from, to);
  const daysInRange = allHistoryDates.length;

  const balances = await Balance.find({})
    .select({ user: 1, firebase_uid: 1, createdAt: 1 })
    .lean();

  let wouldInsert = 0;
  let inserted = 0;

  /** @type {import("mongoose").AnyBulkWriteOperation[]} */
  let batch = [];

  const flush = async () => {
    if (batch.length === 0) return;
    if (apply) {
      const res = await BalanceHistory.bulkWrite(batch, { ordered: false });
      inserted += res.upsertedCount ?? 0;
    }
    batch = [];
  };

  for (const b of balances) {
    if (!b.user) continue;

    const userFirstDay = startOfUtcCalendarDay(balanceCreatedAt(b));

    for (const historyDate of allHistoryDates) {
      if (historyDate.getTime() < userFirstDay.getTime()) continue;

      wouldInsert += 1;

      if (!apply) continue;

      batch.push({
        updateOne: {
          filter: { user: b.user, date: historyDate },
          update: {
            $setOnInsert: {
              user: b.user,
              firebase_uid: b.firebase_uid || undefined,
              date: historyDate,
              balances: INSERT_BALANCES(),
            },
          },
          upsert: true,
        },
      });

      if (batch.length >= bulkSize) await flush();
    }
  }

  await flush();

  return {
    users: balances.filter((x) => x.user).length,
    daysInRange,
    wouldInsert,
    inserted,
  };
}

async function main() {
  const { apply, fromStr, toStr } = parseArgs();
  const rangeStartDay = parseUtcDay(fromStr);
  const rangeEndDay = parseUtcDay(toStr);

  await mongoose.connect(MONGODB_URI);
  console.log("Connected:", mongoose.connection.host);
  console.log(
    `Range (UTC days): ${fromStr} .. ${toStr} | mode: ${apply ? "APPLY" : "dry-run"}`
  );

  const stats = await backfillBalanceHistoryDateRange({
    rangeStartDay,
    rangeEndDay,
    apply,
  });

  console.log(
    `\nUsers (Balance docs): ${stats.users}\n` +
      `Days in range: ${stats.daysInRange}\n` +
      `Upsert operations (one per user-day after creation): ${stats.wouldInsert}`
  );
  if (apply) {
    console.log(`New documents inserted (upserted): ${stats.inserted}`);
  } else {
    console.log(
      "\nDry-run: no writes. Re-run with --apply to insert missing rows."
    );
  }

  await mongoose.disconnect();
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
