import AppSettings from "../models/AppSettings.js";

const KEY_MIN = "withdrawalMinBtc";
const KEY_MAX = "withdrawalMaxBtc";

const DEFAULT_MIN = Number(process.env.WITHDRAWAL_MIN_BTC) || 0.0005;
const DEFAULT_MAX = Number(process.env.WITHDRAWAL_MAX_BTC) || 0.009;

/**
 * Get withdrawal min/max (BTC) from database. Falls back to env or defaults if not set.
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
