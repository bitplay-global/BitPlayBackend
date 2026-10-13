import AppSettings from "../models/AppSettings.js";
import { getBtcUsdPriceCached } from "./btcPrice.js";

const KEY_MIN = "withdrawalMinBtc";
const KEY_MAX = "withdrawalMaxBtc";

const DEFAULT_MIN = Number(process.env.WITHDRAWAL_MIN_BTC) || 0.0005;
const DEFAULT_MAX = Number(process.env.WITHDRAWAL_MAX_BTC) || 0.009;

/**
 * Speed (the Lightning payout provider) refuses anything under 0.5 USDT. The
 * dashboard minimum is a fixed BTC amount, so whenever BTC falls far enough
 * that amount is worth less than $0.50 and every withdrawal at the displayed
 * minimum fails ("at least 0.5 USDT"). This happened in Oct 2026 with the
 * minimum at 0.000005 BTC and BTC near $83,000 (= $0.42).
 */
export const SPEED_MIN_USDT = 0.5;
/** Extra on top of Speed's minimum, so a price move between the app showing
 *  the minimum and the user submitting doesn't push the amount under it. */
export const SPEED_MIN_CUSHION = 0.10;
/** Minimums are rounded UP to this many BTC decimals (0.0000001). */
const MIN_DECIMALS = 7;

/**
 * Smallest BTC amount Speed will accept at a given BTC/USD price, with the
 * cushion, rounded up. 0 when the price is unknown.
 */
export function speedMinimumBtc(btcUsd, { minUsdt = SPEED_MIN_USDT, cushion = SPEED_MIN_CUSHION } = {}) {
  const price = Number(btcUsd);
  if (!Number.isFinite(price) || price <= 0) return 0;
  const raw = (minUsdt * (1 + cushion)) / price;
  const unit = 10 ** MIN_DECIMALS;
  return Math.ceil(raw * unit - 1e-9) / unit;
}

/**
 * Get withdrawal min/max (BTC) as set in the dashboard. Falls back to env or
 * defaults if not set.
 * @returns {Promise<{ minBtc: number, maxBtc: number }>}
 */
export async function getWithdrawalLimits() {
  try {
    const [minDoc, maxDoc] = await Promise.all([
      AppSettings.findOne({ key: KEY_MIN }).lean(),
      AppSettings.findOne({ key: KEY_MAX }).lean(),
    ]);
    const minBtc =
      minDoc != null && typeof minDoc.value === "number" && !Number.isNaN(minDoc.value)
        ? minDoc.value
        : DEFAULT_MIN;
    const maxBtc =
      maxDoc != null && typeof maxDoc.value === "number" && !Number.isNaN(maxDoc.value)
        ? maxDoc.value
        : DEFAULT_MAX;
    return { minBtc, maxBtc };
  } catch (err) {
    console.error("Error reading withdrawal limits from DB:", err);
    return { minBtc: DEFAULT_MIN, maxBtc: DEFAULT_MAX };
  }
}

/**
 * The limits the app and the withdrawal routes must use: the dashboard
 * minimum, raised to Speed's minimum at the current BTC price when that is
 * higher. `minBtc` is what to show and enforce; the other fields say why.
 *
 * If the price can't be fetched the dashboard minimum is used as-is (there
 * is nothing better to do), and `priceKnown` is false.
 *
 * @param {{ priceFn?: () => Promise<number> }} [deps]  for tests
 * @returns {Promise<{ minBtc:number, maxBtc:number, adminMinBtc:number,
 *   speedMinBtc:number, btcUsd:number, priceKnown:boolean, raisedBySpeed:boolean }>}
 */
export async function getEffectiveWithdrawalLimits({ priceFn = () => getBtcUsdPriceCached(60_000) } = {}) {
  const { minBtc: adminMinBtc, maxBtc } = await getWithdrawalLimits();
  let btcUsd = 0;
  try {
    btcUsd = Number(await priceFn()) || 0;
  } catch (err) {
    console.warn("[Withdrawal limits] BTC price unavailable:", err?.message ?? err);
  }
  const speedMinBtc = speedMinimumBtc(btcUsd);
  const minBtc = Math.max(adminMinBtc, speedMinBtc);
  return {
    minBtc,
    maxBtc,
    adminMinBtc,
    speedMinBtc,
    btcUsd,
    priceKnown: btcUsd > 0,
    raisedBySpeed: speedMinBtc > adminMinBtc,
  };
}

/** Error text for a request under the minimum, in the units the user sees. */
export function belowMinimumMessage(limits) {
  const usd = limits.priceKnown ? ` (about $${(limits.minBtc * limits.btcUsd).toFixed(2)})` : "";
  return `Withdrawal amount must be at least ${limits.minBtc} BTC${usd}.`;
}

/**
 * Save withdrawal min/max (BTC) to database. Admin only.
 * @param {number} minBtc
 * @param {number} maxBtc
 * @returns {Promise<{ minBtc: number, maxBtc: number }>}
 */
export async function setWithdrawalLimits(minBtc, maxBtc) {
  const minNum = Number(minBtc);
  const maxNum = Number(maxBtc);
  if (Number.isNaN(minNum) || Number.isNaN(maxNum) || minNum < 0 || maxNum < 0 || minNum > maxNum) {
    throw new Error("Invalid withdrawal limits: min and max must be numbers with 0 <= min <= max.");
  }
  await Promise.all([
    AppSettings.findOneAndUpdate(
      { key: KEY_MIN },
      { $set: { value: minNum } },
      { upsert: true, new: true }
    ),
    AppSettings.findOneAndUpdate(
      { key: KEY_MAX },
      { $set: { value: maxNum } },
      { upsert: true, new: true }
    ),
  ]);
  return { minBtc: minNum, maxBtc: maxNum };
}
