/**
 * Warnings shown next to withdrawal requests in the admin dashboard, so an
 * admin sees the risk before pressing Approve. Read-only; never blocks.
 *
 * Two checks, from the May 2026 payouts audit (2026-10-11):
 *
 * 1. UNEXPLAINED BALANCE: the account holds (or has already been paid) more
 *    BTC than its history can explain. Explained = each mining day, counted
 *    at most what a free account plus the user's purchased power can mine in
 *    a day, + processed referral rewards + credited deposits. Held = current
 *    withdrawable balance + everything already paid out or reserved. Accounts
 *    that "mined" 0.9 BTC or 33 BTC in one day under the old client-trusted
 *    code show up here.
 *
 * 2. SHARED PAYOUT ADDRESS: other accounts have asked for withdrawals to the
 *    same address. One person farming several accounts looks like this (two
 *    May payouts went to one address from two different new accounts).
 *
 * Both are signals, not proof: a support credit or a plan bought before the
 * hashpower was recorded can make an honest account look unexplained.
 */
import mongoose from "mongoose";

/** GH/s a free account can reach in a day (ads, start reward, games, streak). */
export const FREE_ACCOUNT_MAX_GH = 1500;
const BTC_PER_GH_PER_DAY = 0.0000000000000070 * 86400;
/** Ignore differences smaller than this (rounding, a few minutes of mining). */
const TOLERANCE_BTC = 0.00000001;
/** Statuses where the money has left, or is reserved for leaving. */
const PAID_STATUSES = ["APPROVED", "SENT", "CONFIRMED"];

const num = v => {
  if (v == null) return 0;
  const n = Number(typeof v === "object" ? v.toString() : v);
  return Number.isFinite(n) ? n : 0;
};
const normAddress = a => String(a || "").trim().toLowerCase();

/** Most BTC one day can explain for a user with `purchasedGh` bought power. */
export function dayCapBtc(purchasedGh) {
  return (FREE_ACCOUNT_MAX_GH + Math.max(0, num(purchasedGh))) * BTC_PER_GH_PER_DAY;
}

/**
 * Pure part of check 1.
 * @param {object} p
 * @param {number[]} p.dayAmounts   BTC credited per mining day (BalanceHistory)
 * @param {number} p.purchasedGh    the user's purchased GH/s
 * @param {number} p.referralBtc    processed referral rewards
 * @param {number} p.depositBtc     credited on-chain deposits
 * @param {number} p.balanceBtc     current withdrawable balance (BTC_DEPOSIT)
 * @param {number} p.paidOutBtc     withdrawals paid, approved or reserved
 * @returns {{held:number, explained:number, excess:number, impossibleDays:number, biggestDay:number}|null}
 *   null when everything held is explained.
 */
export function unexplainedBalance({ dayAmounts, purchasedGh, referralBtc, depositBtc, balanceBtc, paidOutBtc }) {
  const cap = dayCapBtc(purchasedGh);
  let mined = 0, impossibleDays = 0, biggestDay = 0;
  for (const raw of dayAmounts || []) {
    const d = Math.max(0, num(raw));
    mined += Math.min(d, cap);
    if (d > cap * 1.05) impossibleDays++;
    if (d > biggestDay) biggestDay = d;
  }
  const explained = mined + num(referralBtc) + num(depositBtc);
  const held = num(balanceBtc) + num(paidOutBtc);
  const excess = held - explained;
  if (excess <= Math.max(TOLERANCE_BTC, explained * 0.01)) return null;
  return { held, explained, excess, impossibleDays, biggestDay };
}

/**
 * Warnings for a page of withdrawals.
 * @param {object[]} withdrawals  lean Withdrawal docs
 * @param {import('mongoose').Connection} [conn]
 * @returns {Promise<Map<string, {unexplained: object|null, sharedAddress: object|null}>>}
 *   keyed by withdrawal _id
 */
export async function assessWithdrawals(withdrawals, conn = mongoose.connection) {
  const result = new Map();
  if (!withdrawals?.length) return result;
  const db = conn.db;
  const userIds = [...new Set(withdrawals.map(w => String(w.userId)).filter(Boolean))];

  // ---- check 1, per user ----
  const [history, referrals, deposits, paid, balances, mining] = await Promise.all([
    db.collection("balancehistories").aggregate([
      { $match: { user: { $in: userIds } } },
      { $group: { _id: "$user", days: { $push: { $toDouble: { $ifNull: ["$balances.BTC", 0] } } } } },
    ]).toArray(),
    db.collection("referralrewardhistories").aggregate([
      { $match: { parentUserId: { $in: userIds }, status: "processed" } },
      { $group: { _id: "$parentUserId", s: { $sum: { $toDouble: "$rewardAmount" } } } },
    ]).toArray(),
    db.collection("deposits").aggregate([
      { $match: { user: { $in: userIds }, credited: true } },
      { $group: { _id: "$user", s: { $sum: { $toDouble: "$amountNumeric" } } } },
    ]).toArray(),
    db.collection("withdrawals").aggregate([
      { $match: {
        userId: { $in: userIds },
        $or: [{ status: { $in: PAID_STATUSES } }, { status: "PENDING", balanceDeducted: true }],
      } },
      { $group: { _id: "$userId", s: { $sum: { $toDouble: { $ifNull: ["$defaultAmountNumeric", 0] } } } } },
    ]).toArray(),
    db.collection("balances").find({ user: { $in: userIds } }, { projection: { user: 1, BTC_DEPOSIT: 1 } }).toArray(),
    db.collection("userminings").find({ user: { $in: userIds } }, { projection: { user: 1, purchasedHashpower: 1 } }).toArray(),
  ]);
  const byId = rows => new Map(rows.map(r => [String(r._id), r]));
  const historyBy = byId(history), referralBy = byId(referrals), depositBy = byId(deposits), paidBy = byId(paid);
  const balanceBy = new Map(balances.map(b => [String(b.user), num(b.BTC_DEPOSIT)]));
  const purchasedBy = new Map(mining.map(m => [String(m.user), num(m.purchasedHashpower)]));

  const unexplainedBy = new Map();
  for (const u of userIds) {
    unexplainedBy.set(u, unexplainedBalance({
      dayAmounts: historyBy.get(u)?.days || [],
      purchasedGh: purchasedBy.get(u) || 0,
      referralBtc: referralBy.get(u)?.s || 0,
      depositBtc: depositBy.get(u)?.s || 0,
      balanceBtc: balanceBy.get(u) || 0,
      paidOutBtc: paidBy.get(u)?.s || 0,
    }));
  }

  // ---- check 2, per address ----
  const addresses = [...new Set(withdrawals.map(w => normAddress(w.toAddress)).filter(Boolean))];
  const uses = addresses.length
    ? await db.collection("withdrawals").aggregate([
      { $project: { addr: { $toLower: { $trim: { input: { $ifNull: ["$toAddress", ""] } } } }, userId: 1, status: 1 } },
      { $match: { addr: { $in: addresses } } },
      { $group: {
        _id: { addr: "$addr", userId: "$userId" },
        requests: { $sum: 1 },
        sent: { $sum: { $cond: [{ $in: ["$status", ["SENT", "CONFIRMED"]] }, 1, 0] } },
      } },
    ]).toArray()
    : [];
  const accountsByAddress = new Map();
  for (const r of uses) {
    const list = accountsByAddress.get(r._id.addr) || [];
    list.push({ userId: String(r._id.userId), requests: r.requests, sent: r.sent });
    accountsByAddress.set(r._id.addr, list);
  }
  // Emails for the other accounts, so the admin can recognise them.
  const otherIds = [...new Set(uses.map(r => String(r._id.userId)))];
  const emailBy = new Map();
  if (otherIds.length) {
    const ids = otherIds.map(id => (/^[0-9a-f]{24}$/i.test(id) ? new mongoose.Types.ObjectId(id) : id));
    for (const u of await db.collection("users").find({ _id: { $in: ids } }, { projection: { email: 1 } }).toArray()) {
      emailBy.set(String(u._id), u.email || null);
    }
  }

  for (const w of withdrawals) {
    const u = String(w.userId);
    const others = (accountsByAddress.get(normAddress(w.toAddress)) || [])
      .filter(a => a.userId !== u)
      .map(a => ({ ...a, email: emailBy.get(a.userId) || null }));
    result.set(String(w._id), {
      unexplained: unexplainedBy.get(u) || null,
      sharedAddress: others.length
        ? { accounts: others, sentToOthers: others.reduce((s, a) => s + a.sent, 0) }
        : null,
    });
  }
  return result;
}
