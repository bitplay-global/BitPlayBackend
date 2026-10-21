/**
 * Where a Lightning withdrawal goes: a Lightning address or a Lightning
 * invoice, typed into the same field in the app.
 *
 * Lightning address (LUD-16, `name@domain`, e.g. yourname@speed.app or
 * yourname@zbd.gg): reusable, never expires; Speed pays any of them.
 *
 * Lightning invoice (BOLT11, `lnbc...`): a one-time request for a fixed
 * amount that expires (Speed's are valid 24 h). Accepted only when it is
 * for bitcoin mainnet, carries an amount, that amount equals the
 * withdrawal exactly, and it still has MIN_INVOICE_LIFETIME_S left. It is
 * checked again at approval, so an invoice that expired while waiting is
 * refused there instead of failing at Speed.
 *
 * The app applies the same rules (src/utils/lightningAddress.ts).
 */
import { decodeInvoice, looksLikeInvoice, normalizeInvoice } from "./bolt11.js";

const LIGHTNING_ADDRESS = /^[a-z0-9._+-]{1,64}@(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** An invoice must have at least this long left when the request is made. */
export const MIN_INVOICE_LIFETIME_S = 10 * 60;

export function normalizeLightningAddress(address) {
  return typeof address === "string" ? address.trim().toLowerCase() : "";
}

export function isValidLightningAddress(address) {
  return LIGHTNING_ADDRESS.test(normalizeLightningAddress(address));
}

export function isInvoiceDestination(stored) {
  return typeof stored === "string" && /^ln(bc|tb|bcrt)/i.test(stored.trim());
}

const fmtUtc = (unix) => new Date(unix * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/**
 * Check what the user typed.
 * @param {string} input
 * @param {object} opts
 * @param {number} [opts.expectedSats]  the withdrawal amount in sats
 * @param {number} [opts.now]           unix seconds (tests)
 * @returns {{ ok:true, kind:'address'|'invoice', value:string, invoice?:object }
 *         | { ok:false, error:string }}
 */
export function checkDestination(input, { expectedSats, now = Math.floor(Date.now() / 1000) } = {}) {
  if (looksLikeInvoice(input)) {
    const inv = decodeInvoice(input);
    if (!inv) {
      return { ok: false, error: "That Lightning invoice isn't valid. Copy it again from your wallet, without adding anything to it, or use your Lightning address (e.g. yourname@speed.app)." };
    }
    if (inv.network !== "bitcoin") return { ok: false, error: "That invoice is not for the Bitcoin main network." };
    if (inv.sats == null || inv.sats <= 0) {
      return { ok: false, error: "That invoice has no amount. Create an invoice for the exact amount you want to withdraw, or use your Lightning address." };
    }
    if (inv.msats % 1000 !== 0) return { ok: false, error: "That invoice asks for a fraction of a sat. Create one for a whole number of sats." };
    if (expectedSats != null && inv.sats !== expectedSats) {
      return { ok: false, error: `That invoice is for ${inv.sats} sats, but the withdrawal is for ${expectedSats} sats. Create an invoice for exactly ${expectedSats} sats (${(expectedSats / 1e8).toFixed(8)} BTC).` };
    }
    if (inv.expiresAt - now < MIN_INVOICE_LIFETIME_S) {
      return { ok: false, error: inv.expiresAt <= now ? "That invoice has expired. Create a new one, or use your Lightning address." : "That invoice expires in a few minutes, too soon for the withdrawal to be reviewed. Create a new one, or use your Lightning address." };
    }
    return { ok: true, kind: "invoice", value: normalizeInvoice(input), invoice: inv };
  }
  if (isValidLightningAddress(input)) return { ok: true, kind: "address", value: normalizeLightningAddress(input) };
  return { ok: false, error: "Invalid withdrawal address. Use your Lightning address (e.g. yourname@speed.app) or a Lightning invoice (lnbc…)." };
}

/**
 * At approval: can this stored destination still be paid, and how much?
 * @returns {{ ok:true, kind:string, sats?:number } | { ok:false, error:string }}
 */
export function checkStoredDestinationForPayment(stored, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (!isInvoiceDestination(stored)) return { ok: true, kind: "address" };
  const inv = decodeInvoice(stored);
  if (!inv || inv.sats == null) return { ok: false, error: "The invoice on this withdrawal can't be read. Reject it and ask the user to request again." };
  if (inv.expiresAt <= now + 60) {
    return { ok: false, error: `The invoice on this withdrawal expired at ${fmtUtc(inv.expiresAt)}, so it can no longer be paid. Reject it (the balance is refunded) and ask the user to request again with a new invoice or their Lightning address.` };
  }
  return { ok: true, kind: "invoice", sats: inv.sats, expiresAt: inv.expiresAt };
}

/** For the dashboard: when a stored invoice expires (unix s), or null. */
export function invoiceExpiry(stored) {
  if (!isInvoiceDestination(stored)) return null;
  return decodeInvoice(stored)?.expiresAt ?? null;
}
