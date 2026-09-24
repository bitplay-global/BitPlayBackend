#!/usr/bin/env node
/**
 * Recalculate BTC_DEPOSIT per user from authoritative sources:
 *   sum(BalanceHistory daily mining BTC)
 * + sum(ReferralRewardHistory rewardAmount for parent, processed)
 * + sum(credited on-chain BTC deposits)
 * - sum(completed withdrawal BTC via defaultAmountNumeric)
 * - current session Balance.BTC (unsettled mining — stays in BTC, not deposit)
 *
 * Identity: BTC_DEPOSIT + BTC_session ≈ mining + referral + on_chain_in − withdrawn
 *
 * After changing BalanceHistory (e.g. scripts/balance-history-btc-threshold.js
 * --backfill-btc), run a dry-run first to CHECK rows with non-zero delta, then
 * the same command with --apply to sync Balance.BTC_DEPOSIT.
 *
 * Usage:
 *   node scripts/recalculate-btc-deposit.js           # CHECK: dry-run, print deltas
 *   node scripts/recalculate-btc-deposit.js --apply   # APPLY: write BTC_DEPOSIT
 *   node scripts/recalculate-btc-deposit.js --user=<firebaseOrUserId>
 *
 * Requires MONGODB_URI in .env (or default from database.js).
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";

import Balance from "../models/Balance.js";
import BalanceHistory from "../models/BalanceHistory.js";
import ReferralRewardHistory from "../models/ReferralRewardHistory.js";
import Deposit from "../models/Deposit.js";
import Withdrawal from "../models/Withdrawal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const MONGODB_URI =
  process.env.MONGODB_URI;

function num(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "object" && typeof v.toString === "function") {
    const n = parseFloat(v.toString());
    return Number.isFinite(n) ? n : 0;
  }
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function idToString(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object" && typeof v.toString === "function") {
    return String(v.toString()).trim();
  }
  return String(v).trim();
}

function parseArgs() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  let userFilter = null;
  for (const a of argv) {
    if (a.startsWith("--user=")) {
      userFilter = a.slice("--user=".length).trim();
    }
  }
  return { apply, userFilter };
}

async function aggregateMiningByUser() {
  const rows = await BalanceHistory.aggregate([
    {
      $project: {
        user: 1,
        btc: { $toDouble: { $ifNull: ["$balances.BTC", 0] } },
      },
    },
    {
      $group: {
        _id: "$user",
        miningBtc: { $sum: "$btc" },
      },
    },
  ]);
  return new Map(
    rows
      .map((r) => [idToString(r._id), r.miningBtc || 0])
      .filter(([id]) => Boolean(id))
  );
}

async function aggregateReferralByUser() {
  const rows = await ReferralRewardHistory.aggregate([
    { $match: { status: "processed" } },
    {
      $project: {
        parentUserId: 1,
        amt: { $toDouble: { $ifNull: ["$rewardAmount", 0] } },
      },
    },
    {
      $group: {
        _id: "$parentUserId",
        referralBtc: { $sum: "$amt" },
      },
    },
  ]);
  return new Map(
    rows
      .map((r) => [idToString(r._id), r.referralBtc || 0])
      .filter(([id]) => Boolean(id))
  );
}

async function aggregateDepositsByUser() {
  const rows = await Deposit.aggregate([
    {
      $match: {
        credited: true,
        chain: "btc",
      },
    },
    {
      $addFields: {
        uid: { $ifNull: ["$userId", "$user"] },
      },
    },
    {
      $match: { uid: { $nin: [null, ""] } },
    },
    {
      $project: {
        uid: 1,
        amt: { $toDouble: { $ifNull: ["$amountNumeric", 0] } },
      },
    },
    {
      $group: {
        _id: "$uid",
        depositBtc: { $sum: "$amt" },
      },
    },
  ]);
  return new Map(
    rows
      .map((r) => [idToString(r._id), r.depositBtc || 0])
      .filter(([id]) => Boolean(id))
  );
}

/** Completed payouts: only subtract when we know BTC deducted. */
async function aggregateWithdrawalsByUser() {
  const rows = await Withdrawal.aggregate([
    {
      $match: {
        status: { $in: ["SENT", "CONFIRMED"] },
        defaultAmountNumeric: { $exists: true, $ne: null },
      },
    },
    {
      $project: {
        userId: 1,
        amt: { $toDouble: { $ifNull: ["$defaultAmountNumeric", 0] } },
      },
    },
    {
      $group: {
        _id: "$userId",
        withdrawnBtc: { $sum: "$amt" },
      },
    },
  ]);
  return new Map(
    rows
      .map((r) => [idToString(r._id), r.withdrawnBtc || 0])
      .filter(([id]) => Boolean(id))
  );
}

async function countWithdrawalsMissingBtcAmount() {
  return Withdrawal.countDocuments({
    status: { $in: ["SENT", "CONFIRMED"] },
    $or: [
      { defaultAmountNumeric: { $exists: false } },
      { defaultAmountNumeric: null },
    ],
  });
}

async function collectAllUserIds(miningMap, referralMap, depositMap, withdrawalMap) {
  const ids = new Set();
  for (const m of [miningMap, referralMap, depositMap, withdrawalMap]) {
    for (const k of m.keys()) {
      const id = idToString(k);
      if (id) ids.add(id);
    }
  }
  const fromBalances = await Balance.distinct("user");
  for (const u of fromBalances) {
    const id = idToString(u);
    if (id) ids.add(id);
  }
  return [...ids];
}

async function printBalanceHistoryForUser(userId) {
  const historyRows = await BalanceHistory.find({
    $or: [{ user: userId }, { firebase_uid: userId }],
  })
    .select({ date: 1, balances: 1, user: 1, firebase_uid: 1 })
    .sort({ date: 1, createdAt: 1 })
    .lean();

  console.log("\n--- BalanceHistory rows (date + balances.BTC) ---");
  if (historyRows.length === 0) {
    console.log(`No BalanceHistory rows found for user filter: ${userId}`);
    return;
  }

  for (const row of historyRows) {
    const rowDate = row.date ? new Date(row.date).toISOString() : "N/A";
    const btc = num(row?.balances?.BTC);
    const rowUser = idToString(row.user) || "N/A";
    const rowFirebaseUid = idToString(row.firebase_uid) || "N/A";
    console.log(
      `date=${rowDate} | balances.BTC=${btc.toFixed(16)} | user=${rowUser} | firebase_uid=${rowFirebaseUid}`
    );
  }
  console.log(`Total BalanceHistory rows: ${historyRows.length}`);
}

async function main() {
  const { apply, userFilter } = parseArgs();
  const normalizedUserFilter = idToString(userFilter);

  console.log(
    apply
      ? "MODE: APPLY — writing Balance.BTC_DEPOSIT from history + ledger"
      : "MODE: CHECK (dry-run) — showing computed vs current BTC_DEPOSIT; pass --apply to persist"
  );
  if (normalizedUserFilter) {
    console.log("FILTER: single user", normalizedUserFilter);
  }

  await mongoose.connect(MONGODB_URI);
  console.log("Connected:", mongoose.connection.host);

  if (normalizedUserFilter) {
    await printBalanceHistoryForUser(normalizedUserFilter);
  }

  const miningMap = await aggregateMiningByUser();
  const referralMap = await aggregateReferralByUser();
  const depositMap = await aggregateDepositsByUser();
  const withdrawalMap = await aggregateWithdrawalsByUser();
  const missingWd = await countWithdrawalsMissingBtcAmount();

  let userIds = await collectAllUserIds(
    miningMap,
    referralMap,
    depositMap,
    withdrawalMap
  );
  if (normalizedUserFilter) {
    userIds = userIds.filter((u) => u === normalizedUserFilter);
    if (userIds.length === 0) {
      userIds = [normalizedUserFilter];
    }
  }

  const summary = {
    updated: 0,
    skipped: 0,
    negativeClamped: 0,
    totalDelta: 0,
  };

  for (const userId of userIds) {
    const mining = miningMap.get(userId) || 0;
    const referral = referralMap.get(userId) || 0;
    const onChain = depositMap.get(userId) || 0;
    const withdrawn = withdrawalMap.get(userId) || 0;

    let bal = await Balance.findOne({ user: userId });
    if (!bal) {
      bal = await Balance.findOne({ user: mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : userId });
    }
    if (!bal && apply) {
      bal = await Balance.create({ user: userId });
    }
    if (!bal) {
      const sessionBtc = 0;
      const rawDeposit = mining + referral + onChain - withdrawn ;
      const newDep = Math.max(0, rawDeposit);
      console.log(
        `[dry-run only] Would create user ${userId}: BTC_DEPOSIT=${newDep} (no Balance row yet)`
      );
      continue;
    }

    const sessionBtc = num(bal.BTC);
    const oldDep = num(bal.BTC_DEPOSIT);

    const rawDeposit = mining + referral + onChain - withdrawn;
    let newDep = rawDeposit;
    if (rawDeposit < 0) {
      summary.negativeClamped++;
      newDep = 0;
    }

    const delta = newDep - oldDep;
    summary.totalDelta += delta;

    const line = [
      `user=${userId}`,
      `mining=${mining.toFixed(12)}`,
      `referral=${referral.toFixed(12)}`,
      `onChain=${onChain.toFixed(12)}`,
      `withdrawn=${withdrawn.toFixed(12)}`,
      `sessionBTC=${sessionBtc.toFixed(12)}`,
      `old_DEPOSIT=${oldDep.toFixed(12)}`,
      `new_DEPOSIT=${newDep.toFixed(12)}`,
      `delta=${delta.toFixed(12)}`,
    ].join(" | ");

    if (Math.abs(delta) < 1e-16) {
      summary.skipped++;
      continue;
    }

    console.log(line);

    if (apply) {
      bal.BTC_DEPOSIT = mongoose.Types.Decimal128.fromString(newDep.toFixed(16));
      await bal.save();
      summary.updated++;
    }
  }

  console.log("\n--- Summary ---");
  console.log(
    "SENT/CONFIRMED withdrawals missing defaultAmountNumeric (BTC not subtracted in this run):",
    missingWd
  );
  console.log("Users processed:", userIds.length);
  if (apply) {
    console.log("Rows updated:", summary.updated);
    console.log("Rows unchanged (delta ~0):", summary.skipped);
  }
  console.log("Negative raw deposit clamped to 0:", summary.negativeClamped);
  console.log("Sum of (new-old) BTC_DEPOSIT:", summary.totalDelta);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});



// cd btc-mining-backend
// # Dry-run (default — no DB writes)
// node scripts/recalculate-btc-deposit.js

// # Apply updates
// node scripts/recalculate-btc-deposit.js --apply

// # One user (debug)
// node scripts/recalculate-btc-deposit.js --user=YOUR_USER_ID

// node scripts/recalculate-btc-deposit.js --user="69908c40f7ae9d1d478c6bcf" --apply


