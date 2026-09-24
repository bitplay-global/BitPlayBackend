import axios from "axios";

/**
 * Last-resort rates (1 unit of currency = X USD), used only when the live
 * rate API is unreachable (and there's no usable cache yet) or returns a code
 * this table doesn't have covered. These are rough and will drift out of
 * date -- they exist purely as a safety net so a purchase never gets counted
 * 1:1 with USD by default (which is exactly the TWD-counted-as-USD bug: any
 * currency missing from this table used to silently fall back to a rate of
 * 1). The live API below is the real source of truth and covers virtually
 * every ISO 4217 code, so this table only matters during an outage.
 */
const FALLBACK_RATES = {
  USD: 1, EUR: 1.08, GBP: 1.27, CHF: 1.13, CAD: 0.74, AUD: 0.65, NZD: 0.6,
  JPY: 0.0067, CNY: 0.14, HKD: 0.13, TWD: 0.031, KRW: 0.00075, SGD: 0.74,
  INR: 0.012, PKR: 0.0036, BDT: 0.0084, LKR: 0.0033, NPR: 0.0075,
  IDR: 0.000063, MYR: 0.21, THB: 0.0285, VND: 0.00004, PHP: 0.017,
  SAR: 0.27, AED: 0.27, QAR: 0.27, KWD: 3.25, BHD: 2.65, OMR: 2.6, JOD: 1.41,
  EGP: 0.02, MAD: 0.1, DZD: 0.0075, TND: 0.32, NGN: 0.00068, KES: 0.0078,
  GHS: 0.068, ZAR: 0.054, TZS: 0.0004, UGX: 0.00027, ZMW: 0.037,
  XOF: 0.0016, XAF: 0.0016,
  MXN: 0.058, BRL: 0.2, ARS: 0.001, CLP: 0.001, COP: 0.00023, PEN: 0.27,
  VES: 0.017, CRC: 0.00196,
  TRY: 0.029, RUB: 0.0105, UAH: 0.024, ILS: 0.27,
  SEK: 0.095, NOK: 0.091, DKK: 0.145, PLN: 0.25, CZK: 0.043, HUF: 0.0027,
  RON: 0.22, BGN: 0.55, HRK: 0.14, ISK: 0.0072, RSD: 0.0092,
};

/** FX rates don't need to be fresher than this for revenue reporting. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let cachedRates = null;
let cachedAt = 0;

/**
 * open.er-api.com: free, no API key/signup required. Returns how much of
 * each currency 1 USD buys; inverted here to "1 unit of X = ? USD" to match
 * how toUsd() is used everywhere (multiplying a foreign-currency amount).
 */
async function fetchLiveRates() {
  const { data } = await axios.get("https://open.er-api.com/v6/latest/USD", { timeout: 8000 });
  if (data?.result !== "success" || !data.rates) {
    throw new Error("Unexpected response from FX rate API");
  }
  const rates = { USD: 1 };
  for (const [code, rate] of Object.entries(data.rates)) {
    if (typeof rate === "number" && rate > 0) rates[code] = 1 / rate;
  }
  return rates;
}

/**
 * Live rates merged over the static fallback (live values win where both
 * exist), cached for CACHE_TTL_MS. On a failed fetch, serves a stale cache
 * if one exists rather than the static table alone -- a few-hours-old real
 * rate beats a guess that could be years out of date.
 */
export async function getRatesTable() {
  const now = Date.now();
  if (cachedRates && now - cachedAt < CACHE_TTL_MS) return cachedRates;

  try {
    const live = await fetchLiveRates();
    cachedRates = { ...FALLBACK_RATES, ...live };
    cachedAt = now;
    return cachedRates;
  } catch (err) {
    console.error("Currency rate fetch failed, falling back:", err.message);
    return cachedRates || FALLBACK_RATES;
  }
}

/**
 * Convert a currency amount to USD using the given rates table (from
 * getRatesTable()). `ratesTable` defaults to the static fallback so this
 * still works as a plain sync helper wherever a live table isn't available.
 */
export function toUsd(amount, currencyCode, ratesTable = FALLBACK_RATES) {
  if (amount == null || Number.isNaN(Number(amount))) return 0;
  const code = (currencyCode || "USD").toUpperCase();
  const rate = ratesTable[code] ?? FALLBACK_RATES[code] ?? 1;
  return Number(amount) * rate;
}

export { FALLBACK_RATES };
