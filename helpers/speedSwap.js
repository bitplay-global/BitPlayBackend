/**
 * Top up the Speed account's SATS balance from its own USDT balance.
 *
 * Withdrawals are paid over Lightning, which Speed always draws from the
 * SATS balance. When that runs out, the approval route calls this to swap
 * USDT into sats (Speed's /balances/swap; no fee, at most 3 swaps a day)
 * and then retries the payment. It only ever moves money between the
 * account's own two balances -- it pays nobody.
 *
 * Amounts: Speed's swap takes `currency: "USD"` with a whole-dollar
 * `amount` (verified 2026-10-20: a $20 quote = 2000 USDT cents out,
 * ~24,000 sats in). Balances report USDT in cents.
 *
 * Swaps a buffer, not just one payment, so the daily limit isn't spent
 * one withdrawal at a time: max(SPEED_AUTO_SWAP_USD (default 20), 1.2x the
 * payment), never more than the USDT available. A quote is taken first and
 * checked against our own price, so a units mistake can never swap far
 * more than intended.
 */
import { getBtcUsdPriceCached } from "./btcPrice.js";

const API = "https://api.tryspeed.com";

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function autoSwapUsd() {
  const v = Number(process.env.SPEED_AUTO_SWAP_USD);
  return Number.isFinite(v) && v > 0 ? v : 20;
}

/**
 * @param {object} p
 * @param {number} p.neededSats        the payment that didn't fit
 * @param {Function} p.request         axios.request (injectable for tests)
 * @param {string} p.authHeader        Speed Basic auth header
 * @param {() => Promise<number>} [p.priceFn]
 * @returns {Promise<{id:string, usd:number, sats:number}>}
 * @throws if anything doesn't add up; then no swap was requested, or the
 *   swap's own error is passed on.
 */
export async function topUpSatsFromUsdt({ neededSats, request, authHeader, priceFn = () => getBtcUsdPriceCached(60_000) }) {
  const headers = { "Content-Type": "application/json", Authorization: authHeader };
  const call = (method, path, data) => request({ method, url: API + path, headers, data, timeout: 30_000 }).then(r => r.data);

  const btcUsd = Number(await priceFn()) || 0;
  if (!(btcUsd > 0)) throw new Error("BTC price unavailable");
  const neededUsd = (neededSats / 1e8) * btcUsd;

  const bal = await call("get", "/balances");
  const usdtCents = Number((bal?.available || []).find(b => b.target_currency === "USDT")?.amount) || 0;
  const availableUsd = Math.floor(usdtCents) / 100;
  const usd = Math.min(Math.max(autoSwapUsd(), Math.ceil(neededUsd * 1.2 * 100) / 100), Math.floor(availableUsd * 100) / 100);
  if (!(usd > 0) || usd < neededUsd) throw new Error(`not enough USDT to cover the payment (available $${availableUsd.toFixed(2)}, needed $${neededUsd.toFixed(2)})`);

  const body = { amount: String(usd), currency: "USD", target_currency_swap_out: "USDT", target_currency_swap_in: "SATS" };
  const quote = await call("post", "/balances/swap/quote", body);
  const quotedSats = Number(quote?.target_amount_swap_in) || 0;
  const expectSats = (usd / btcUsd) * 1e8;
  // Within 10% of our own price either way, and enough for the payment.
  if (!(quotedSats >= neededSats && quotedSats > expectSats * 0.9 && quotedSats < expectSats * 1.1)) {
    throw new Error(`swap quote out of range: ${quotedSats} sats for $${usd} (expected ~${Math.round(expectSats)})`);
  }

  let swap = await call("post", "/balances/swap", body);
  if (!swap?.id) throw new Error(`swap not created: ${JSON.stringify(swap).slice(0, 200)}`);
  // A new swap is reported as in progress for a moment (seen 2026-10-20: it
  // completed ~70 ms later). Wait up to ~10 s for it to finish.
  for (let i = 0; i < 10 && swap.status && swap.status !== "completed" && swap.status !== "failed"; i++) {
    await sleep(1000);
    swap = await call("get", `/balances/swap/${swap.id}`);
  }
  if (swap.status && swap.status !== "completed") {
    throw new Error(`swap ${swap.id} not completed (status ${swap.status})`);
  }
  return { id: swap.id, usd, sats: Number(swap.target_amount_swap_in ?? swap.target_amount) || quotedSats };
}
