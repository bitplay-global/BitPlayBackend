import Withdrawal from "../models/Withdrawal.js";
import Purchase from "../models/Purchase.js";
import AdMultiplierPrivilege from "../models/AdMultiplierPrivilege.js";
import dbHelpers from "../helpers/helper_functions.js";
import { fetchAdMobRevenue } from "./admobApi.js";
import { getRatesTable, toUsd } from "./currencyConversion.js";

function toNum(val) {
  if (val == null) return 0;
  if (typeof val === "number" && !Number.isNaN(val)) return val;
  if (typeof val === "object" && val.toString) return parseFloat(val.toString()) || 0;
  return parseFloat(val) || 0;
}

/** Parse startDate/endDate (YYYY-MM-DD) to Date; default last 30 days. allTime: use very wide range. */
function parseDateRange(startDate, endDate, allTime) {
  if (allTime) {
    const end = new Date();
    const start = new Date(end);
    start.setFullYear(start.getFullYear() - 10);
    return { start, end };
  }
  const end = endDate ? new Date(endDate + "T23:59:59.999Z") : new Date();
  let start;
  if (startDate) {
    start = new Date(startDate + "T00:00:00.000Z");
  } else {
    start = new Date(end);
    start.setDate(start.getDate() - 30);
  }
  return { start, end };
}

/**
 * Get AdMob revenue from AdMob Reporting API (iOS and Android breakdown).
 * options: { startDate?, endDate?, allTime? } — passed to API for date-filtered report.
 */
async function getAdMobRevenue(options = {}) {
  try {
    const result = await fetchAdMobRevenue(options);
    const total = toNum(result.admobRevenueTotal);
    const code = result.admobCurrencyCode || "USD";
    const totalUsd = code === "USD" ? total : toUsd(total, code, await getRatesTable());
    return {
      ...result,
      admobRevenueTotalUsd: totalUsd,
    };
  } catch (err) {
    console.error("Error fetching AdMob revenue:", err);
    return {
      admobRevenueIos: 0,
      admobRevenueAndroid: 0,
      admobRevenueTotal: 0,
      admobCurrencyCode: "USD",
      admobRevenueTotalUsd: 0,
    };
  }
}

/**
 * Every completed in-app purchase, from both collections that grant one:
 * plan purchases (Purchase, POST /api/purchases/:userId) and Super Privilege
 * purchases (AdMultiplierPrivilege, POST /api/privileges/:userId). They were
 * summed from Purchase alone, so a completed Super Privilege purchase showed
 * correctly in its own "Super Miner" list but never counted toward the
 * dashboard's in-app-purchases total.
 */
async function getCombinedIapRows(dateMatch, fields) {
  const select = fields.join(" ");
  const [purchases, privileges] = await Promise.all([
    Purchase.find({ status: "completed", ...dateMatch }).select(select).lean(),
    AdMultiplierPrivilege.find({ status: "completed", ...dateMatch }).select(select).lean(),
  ]);
  return [...purchases, ...privileges];
}

/**
 * Purchase total (IAP) in USD: sum of price_paid converted to USD by currency.
 * Purchase records are created only in POST /api/purchases/:userId. Separate from Userplan.
 */
async function getPurchaseTotal() {
  try {
    const [list, rates] = await Promise.all([
      getCombinedIapRows({}, ["price_paid", "currency"]),
      getRatesTable(),
    ]);
    let totalUsd = 0;
    for (const p of list) {
      totalUsd += toUsd(toNum(p.price_paid), p.currency, rates);
    }
    return totalUsd;
  } catch (err) {
    console.error("Error getting purchase total:", err);
    return 0;
  }
}

/**
 * Total paid out (withdrawals): sum of amountNumeric where status is SENT or CONFIRMED
 */
async function getTotalWithdrawals() {
  try {
    const list = await Withdrawal.find({ status: { $in: ["SENT", "CONFIRMED"] } })
      .select("amountNumeric")
      .lean();
    let total = 0;
    for (const w of list) {
      total += toNum(w.amountNumeric);
    }
    return total;
  } catch (err) {
    console.error("Error getting total withdrawals:", err);
    return 0;
  }
}

/** Withdrawals total within date range (created_at). */
async function getTotalWithdrawalsFiltered(start, end) {
  try {
    const result = await Withdrawal.aggregate([
      { $match: { status: { $in: ["SENT", "CONFIRMED"] }, created_at: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: { $convert: { input: "$amountNumeric", to: "double", onError: 0, onNull: 0 } } } } },
    ]);
    return toNum(result[0]?.total);
  } catch (err) {
    console.error("Error getting filtered withdrawals total:", err);
    return 0;
  }
}

/** Purchase total in USD within date range (purchase_date). Converts each currency to USD. */
async function getPurchaseTotalFiltered(start, end) {
  try {
    const [list, rates] = await Promise.all([
      getCombinedIapRows(
        { purchase_date: { $gte: start, $lte: end } },
        ["price_paid", "currency"],
      ),
      getRatesTable(),
    ]);
    let totalUsd = 0;
    for (const p of list) {
      totalUsd += toUsd(toNum(p.price_paid), p.currency, rates);
    }
    return totalUsd;
  } catch (err) {
    console.error("Error getting filtered purchase total:", err);
    return 0;
  }
}

/** Recent withdrawals in date range for table. */
async function getRecentWithdrawals(limit = 20, start, end) {
  try {
    const match = { status: { $in: ["SENT", "CONFIRMED"] } };
    if (start && end) match.created_at = { $gte: start, $lte: end };
    const list = await Withdrawal.find(match)
      .sort({ created_at: -1 })
      .limit(limit)
      .lean();
    return list.map((w) => ({
      _id: w._id,
      userId: w.userId,
      asset: w.asset,
      toAddress: w.toAddress,
      amountNumeric: toNum(w.amountNumeric),
      status: w.status,
      created_at: w.created_at,
    }));
  } catch (err) {
    console.error("Error getting recent withdrawals:", err);
    return [];
  }
}

/** Chart data for IAP revenue by month (USD) within date range. Converts each purchase to USD. */
async function getMonthlyRevenueForChartFiltered(start, end) {
  try {
    const [list, rates] = await Promise.all([
      getCombinedIapRows(
        { purchase_date: { $gte: start, $lte: end } },
        ["price_paid", "currency", "purchase_date"],
      ),
      getRatesTable(),
    ]);
    const byMonth = {};
    for (const p of list) {
      const usd = toUsd(toNum(p.price_paid), p.currency, rates);
      const d = p.purchase_date ? new Date(p.purchase_date) : new Date();
      const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      byMonth[monthKey] = (byMonth[monthKey] || 0) + usd;
    }
    const sorted = Object.keys(byMonth).sort();
    const labels = sorted.map((id) => {
      const [y, m] = id.split("-");
      return new Date(Number(y), Number(m) - 1, 1).toLocaleString("default", { month: "short", year: "2-digit" });
    });
    const data = sorted.map((id) => byMonth[id]);
    return { labels, data };
  } catch (err) {
    console.error("Error getting chart data filtered:", err);
    return { labels: [], data: [] };
  }
}

/**
 * Recent transactions: last N from purchases (in) and withdrawals (out), merged and sorted by date
 */
async function getRecentTransactions(limit = 10) {
  try {
    const [purchases, privileges, withdrawals] = await Promise.all([
      Purchase.find({ status: "completed" })
        .sort({ purchase_date: -1 })
        .limit(limit)
        .lean(),
      AdMultiplierPrivilege.find({ status: "completed" })
        .sort({ purchase_date: -1 })
        .limit(limit)
        .lean(),
      Withdrawal.find({ status: { $in: ["SENT", "CONFIRMED"] } })
        .sort({ created_at: -1 })
        .limit(limit)
        .lean(),
    ]);
    const items = [
      ...[...purchases, ...privileges].map((p) => ({
        type: "subscription",
        date: p.purchase_date || p.createdAt,
        title: "Subscription / IAP",
        sub: p.product_identifier || "In-app purchase",
        amount: toNum(p.price_paid),
        positive: true,
      })),
      ...withdrawals.map((w) => ({
        type: "withdrawal",
        date: w.created_at,
        title: "Withdrawal",
        sub: w.asset || w.toAddress ? `${w.asset} to ${String(w.toAddress).slice(0, 12)}…` : "Paid out",
        amount: toNum(w.amountNumeric),
        positive: false,
      })),
    ];
    items.sort((a, b) => new Date(b.date) - new Date(a.date));
    return items.slice(0, limit);
  } catch (err) {
    console.error("Error getting recent transactions:", err);
    return [];
  }
}

/**
 * Monthly revenue for chart (last 12 months): IAP in USD by month.
 */
async function getMonthlyRevenueForChart() {
  try {
    const now = new Date();
    const months = [];
    const labels = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(d);
      labels.push(d.toLocaleString("default", { month: "short", year: "2-digit" }));
    }

    const [list, rates] = await Promise.all([
      getCombinedIapRows({}, ["price_paid", "currency", "purchase_date"]),
      getRatesTable(),
    ]);
    const purMap = {};
    for (const p of list) {
      const usd = toUsd(toNum(p.price_paid), p.currency, rates);
      const d = p.purchase_date ? new Date(p.purchase_date) : new Date();
      const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      purMap[monthKey] = (purMap[monthKey] || 0) + usd;
    }

    const data = months.map((m) => {
      const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
      return purMap[key] || 0;
    });

    return { labels, data };
  } catch (err) {
    console.error("Error getting monthly revenue:", err);
    return {
      labels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
      data: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
  }
}

/**
 * All dashboard stats in one call. Revenue = IAP + AdMob only (no Userplan subscription).
 */
export async function getDashboardStats() {
  const [
    admob,
    purchaseTotal,
    totalWithdrawals,
    chartData,
    recentWithdrawals,
    usersCount,
    supportTicketsCount,
  ] = await Promise.all([
    getAdMobRevenue(),
    getPurchaseTotal(),
    getTotalWithdrawals(),
    getMonthlyRevenueForChart(),
    getRecentWithdrawals(20),
    dbHelpers.total_users().catch(() => 0),
    dbHelpers.TotalSupportTickets().catch(() => 0),
  ]);

  const pur = toNum(purchaseTotal);
  const admobUsd = toNum(admob.admobRevenueTotalUsd);
  const totalRevenue = pur + admobUsd;

  return {
    totalRevenue,
    purchaseTotal,
    admobRevenueIos: admob.admobRevenueIos,
    admobRevenueAndroid: admob.admobRevenueAndroid,
    admobRevenueTotal: admob.admobRevenueTotal,
    admobRevenueTotalUsd: admobUsd,
    admobCurrencyCode: admob.admobCurrencyCode || "USD",
    totalWithdrawals,
    recentWithdrawals,
    chartLabels: chartData.labels,
    chartData: chartData.data,
    usersCount,
    supportTicketsCount,
  };
}

/**
 * Dashboard stats filtered by date range. For analytical view.
 * options: startDate, endDate (YYYY-MM-DD), allTime (boolean).
 */
export async function getDashboardStatsFiltered(options = {}) {
  const { startDate, endDate, allTime } = options;
  const { start, end } = parseDateRange(startDate, endDate, allTime);

  const [
    admob,
    purchaseTotal,
    totalWithdrawals,
    chartData,
    recentWithdrawals,
    usersCount,
    supportTicketsCount,
  ] = await Promise.all([
    getAdMobRevenue({ startDate, endDate, allTime }),
    getPurchaseTotalFiltered(start, end),
    getTotalWithdrawalsFiltered(start, end),
    getMonthlyRevenueForChartFiltered(start, end),
    getRecentWithdrawals(20, start, end),
    dbHelpers.total_users_filtered(start, end).catch(() => 0),
    dbHelpers.TotalSupportTicketsFiltered(start, end).catch(() => 0),
  ]);

  const pur = toNum(purchaseTotal);
  const admobUsd = toNum(admob.admobRevenueTotalUsd);
  const totalRevenue = pur + admobUsd;

  return {
    totalRevenue,
    purchaseTotal,
    admobRevenueIos: admob.admobRevenueIos,
    admobRevenueAndroid: admob.admobRevenueAndroid,
    admobRevenueTotal: admob.admobRevenueTotal,
    admobRevenueTotalUsd: admobUsd,
    admobCurrencyCode: admob.admobCurrencyCode || "USD",
    totalWithdrawals,
    recentWithdrawals,
    chartLabels: chartData.labels,
    chartData: chartData.data,
    usersCount,
    supportTicketsCount,
    dateRange: { start, end },
  };
}

export {
  getPurchaseTotal,
  getTotalWithdrawals,
  getRecentTransactions,
  getMonthlyRevenueForChart,
  parseDateRange,
};
