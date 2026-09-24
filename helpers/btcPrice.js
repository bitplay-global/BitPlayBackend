/**
 * Cached BTC/USD price: CoinGecko first, Binance fallback.
 * Use for converting USDT (USD) amounts to BTC in admin/APIs.
 */

let cachedUsdPrice = null;
let cachedAtMs = 0;
let inFlight = null;

async function fetchFromCoinGecko() {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
  );
  if (res.status === 429) throw Object.assign(new Error("Rate limited"), { response: { status: 429 } });
  if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
  const data = await res.json();
  const price = data?.bitcoin?.usd;
  return typeof price === "number" ? price : 0;
}

async function fetchFromBinance() {
  const res = await fetch(
    "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
  );
  if (!res.ok) throw new Error(`Binance error: ${res.status}`);
  const data = await res.json();
  const price = parseFloat(data?.price);
  return Number.isFinite(price) ? price : 0;
}

/**
 * Get BTC price in USD, cached for ttlMs. Uses CoinGecko then Binance fallback.
 * @param {number} [ttlMs=60000] - Cache TTL in milliseconds (default 60s).
 * @returns {Promise<number>} - Price in USD, or 0 if both sources fail.
 */
export async function getBtcUsdPriceCached(ttlMs = 60_000) {
  const now = Date.now();
  if (cachedUsdPrice != null && now - cachedAtMs < ttlMs) return cachedUsdPrice;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const price = await fetchFromCoinGecko();
      if (price > 0) {
        cachedUsdPrice = price;
        cachedAtMs = Date.now();
        return price;
      }
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) {
        console.warn("[BTC Price] CoinGecko rate-limited (429).");
      } else {
        console.warn("[BTC Price] CoinGecko fetch failed:", err?.message ?? err);
      }
    }

    try {
      const price = await fetchFromBinance();
      if (price > 0) {
        cachedUsdPrice = price;
        cachedAtMs = Date.now();
        return price;
      }
    } catch (err) {
      console.warn("[BTC Price] Binance fetch failed:", err?.message ?? err);
    }

    return cachedUsdPrice ?? 0;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}
