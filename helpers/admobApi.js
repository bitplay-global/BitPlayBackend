/**
 * Fetch AdMob revenue via Google AdMob Reporting API.
 * Uses OAuth (user auth): tokens from Settings/DB, refreshed automatically.
 * Env: ADMOB_ACCOUNT_ID (publisher ID), ADMOB_CLIENT_ID, ADMOB_CLIENT_SECRET.
 * Set tokens in Admin → Settings → AdMob (Connect with Google or paste refresh token).
 */
import axios from "axios";
import { getValidAccessToken } from "./admobAuth.js";

const ADMOB_API_BASE = "https://admob.googleapis.com/v1";

function microsToUnits(micros) {
  if (micros == null || Number.isNaN(Number(micros))) return 0;
  return Number(micros) / 1_000_000;
}

/**
 * Fetch AdMob account info to get currencyCode (e.g. USD, SAR).
 */
async function fetchAdMobAccountCurrency(accessToken, parent) {
  try {
    const res = await axios.get(`${ADMOB_API_BASE}/${parent}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10000,
    });
    const code = res.data?.currencyCode;
    return typeof code === "string" && code.length === 3 ? code.toUpperCase() : "USD";
  } catch (_) {
    return "USD";
  }
}

/** Parse YYYY-MM-DD to AdMob format { year, month, day }. */
function toAdMobDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;
  const d = new Date(dateStr + "T00:00:00.000Z");
  if (Number.isNaN(d.getTime())) return null;
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Fetch AdMob network report (ESTIMATED_EARNINGS by PLATFORM).
 * Returns amounts in account currency (micros → units) and admobCurrencyCode.
 * options: { startDate?: string (YYYY-MM-DD), endDate?: string, allTime?: boolean }
 * - If allTime or no dates: uses last 10 years to today. Otherwise uses given range.
 */
export async function fetchAdMobRevenue(options = {}) {
  const accountId = process.env.ADMOB_ACCOUNT_ID;
  if (!accountId || typeof accountId !== "string" || !accountId.trim()) {
    console.warn("AdMob: ADMOB_ACCOUNT_ID not set (e.g. pub-1234567890123456)");
    return { admobRevenueIos: 0, admobRevenueAndroid: 0, admobRevenueTotal: 0, admobCurrencyCode: "USD" };
  }
  const parent = accountId.startsWith("accounts/") ? accountId : `accounts/${accountId.trim()}`;

  let accessToken;
  try {
    accessToken = await getValidAccessToken();
  } catch (err) {
    console.error("AdMob: Failed to get access token:", err?.message ?? err);
    return { admobRevenueIos: 0, admobRevenueAndroid: 0, admobRevenueTotal: 0, admobCurrencyCode: "USD" };
  }
  if (!accessToken) {
    return { admobRevenueIos: 0, admobRevenueAndroid: 0, admobRevenueTotal: 0, admobCurrencyCode: "USD" };
  }

  const currencyCode = await fetchAdMobAccountCurrency(accessToken, parent);

  const now = new Date();
  let startDateObj, endDateObj;
  if (options.allTime) {
    const start = new Date(now);
    start.setFullYear(start.getFullYear() - 10);
    startDateObj = { year: start.getFullYear(), month: start.getMonth() + 1, day: start.getDate() };
    endDateObj = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  } else if (options.startDate && options.endDate) {
    startDateObj = toAdMobDate(options.startDate);
    endDateObj = toAdMobDate(options.endDate);
    if (!startDateObj || !endDateObj) {
      const start = new Date(now);
      start.setDate(start.getDate() - 30);
      startDateObj = { year: start.getFullYear(), month: start.getMonth() + 1, day: start.getDate() };
      endDateObj = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
    }
  } else {
    const start = new Date(now);
    start.setFullYear(start.getFullYear() - 1);
    startDateObj = { year: start.getFullYear(), month: start.getMonth() + 1, day: start.getDate() };
    endDateObj = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  }

  const reportSpec = {
    dateRange: { startDate: startDateObj, endDate: endDateObj },
    dimensions: ["PLATFORM"],
    metrics: ["ESTIMATED_EARNINGS"],
    timeZone: "America/Los_Angeles",
    sortConditions: [{ dimension: "PLATFORM", order: "ASCENDING" }],
  };

  const url = `${ADMOB_API_BASE}/${parent}/networkReport:generate`;
  try {
    const res = await axios.post(
      url,
      { reportSpec },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        responseType: "text",
        timeout: 60000,
      }
    );

    const raw = res.data;
    let chunks = [];
    try {
      const parsed = JSON.parse(raw);
      chunks = Array.isArray(parsed) ? parsed : parsed?.responses ?? [parsed];
    } catch (_) {
      const lines = String(raw).split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          chunks.push(JSON.parse(line));
        } catch (__) {}
      }
    }

    let ios = 0;
    let android = 0;
    for (const chunk of chunks) {
      const row = chunk.row;
      if (!row?.metricValues) continue;
      const earnings = row.metricValues.ESTIMATED_EARNINGS;
      const microsVal = earnings?.microsValue ?? earnings?.integerValue;
      if (microsVal == null) continue;
      const micros = Number(microsVal);
      if (Number.isNaN(micros)) continue;
      const platform = row.dimensionValues?.PLATFORM?.value ?? "";
      const normalized = String(platform).toLowerCase();
      if (normalized === "ios") ios += micros;
      else if (normalized === "android") android += micros;
    }

    const admobRevenueIos = microsToUnits(ios);
    const admobRevenueAndroid = microsToUnits(android);
    return {
      admobRevenueIos,
      admobRevenueAndroid,
      admobRevenueTotal: admobRevenueIos + admobRevenueAndroid,
      admobCurrencyCode: currencyCode,
    };
  } catch (err) {
    const msg = err.response?.data?.error?.message ?? err.message;
    console.error("AdMob API error:", msg);
    return { admobRevenueIos: 0, admobRevenueAndroid: 0, admobRevenueTotal: 0, admobCurrencyCode: "USD" };
  }
}
