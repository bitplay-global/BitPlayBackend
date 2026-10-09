/**
 * The BTC deposit account key, resolved one way for every caller.
 *
 * Deposit address idx is the p2wpkh address of m/84'/0'/0'/0/idx. The account
 * node m/84'/0'/0' can be configured as:
 *   BTC_XPUB  account-level public key (depth 3). Preferred: the server can
 *             issue addresses but cannot spend.
 *   BTC_XPRV  either a root key (depth 0), from which m/84'/0'/0' is derived,
 *             or an account-level private key (depth 3), used as-is.
 *
 * When both are set they must describe the same account. They once did not:
 * BTC_XPUB came from a different seed than BTC_XPRV, the route preferred
 * BTC_XPUB, and so it would have issued addresses nobody can spend. An
 * account-level BTC_XPRV was also wrongly treated as a root key. A mismatch
 * is now an error, and callers refuse to issue addresses rather than guess.
 */
import BIP32Factory from 'bip32';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';

const bip32 = BIP32Factory(ecc);
export const BTC_NETWORK = bitcoin.networks.bitcoin;
export const ACCOUNT_PATH = "84'/0'/0'";

function parse(label, b58) {
  try { return { node: bip32.fromBase58(String(b58).trim(), BTC_NETWORK) }; }
  catch (e) { return { error: `${label} is not a valid mainnet extended key (${e.message})` }; }
}

/** Neutered account node from an xprv of depth 0 (root) or 3 (account). */
function accountFromXprv(node) {
  if (node.isNeutered()) return { error: 'BTC_XPRV holds a public key; put it in BTC_XPUB' };
  if (node.depth === 0) return { account: node.derivePath(ACCOUNT_PATH).neutered() };
  if (node.depth === 3) return { account: node.neutered() };
  return { error: `BTC_XPRV has depth ${node.depth}; expected 0 (root) or 3 (account m/${ACCOUNT_PATH})` };
}

/**
 * @param {{xprv?: string, xpub?: string}} env
 * @returns {{account: import('bip32').BIP32Interface|null, source: string|null, error: string|null}}
 */
export function resolveBtcAccount({ xprv, xpub } = {}) {
  let fromXprv = null, fromXpub = null;

  if (xprv) {
    const p = parse('BTC_XPRV', xprv);
    if (p.error) return { account: null, source: null, error: p.error };
    const a = accountFromXprv(p.node);
    if (a.error) return { account: null, source: null, error: a.error };
    fromXprv = a.account;
  }
  if (xpub) {
    const p = parse('BTC_XPUB', xpub);
    if (p.error) return { account: null, source: null, error: p.error };
    if (!p.node.isNeutered()) return { account: null, source: null, error: 'BTC_XPUB holds a private key; put it in BTC_XPRV' };
    if (p.node.depth !== 3) return { account: null, source: null, error: `BTC_XPUB has depth ${p.node.depth}; expected 3 (account m/${ACCOUNT_PATH})` };
    fromXpub = p.node;
  }

  if (!fromXprv && !fromXpub) return { account: null, source: null, error: 'neither BTC_XPUB nor BTC_XPRV is set' };
  if (fromXprv && fromXpub && fromXprv.toBase58() !== fromXpub.toBase58()) {
    return { account: null, source: null, error: 'BTC_XPUB is not the account key of BTC_XPRV (different seeds); fix .env before issuing addresses' };
  }
  return fromXpub
    ? { account: fromXpub, source: 'BTC_XPUB', error: null }
    : { account: fromXprv, source: 'BTC_XPRV', error: null };
}

/** p2wpkh deposit address for idx under the (neutered) account node. */
export function deriveBtcAddress(account, idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= 0x80000000) throw new Error(`invalid address index ${idx}`);
  const child = account.derivePath(`0/${idx}`);
  const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(child.publicKey), network: BTC_NETWORK });
  return { address, derivationPath: `${ACCOUNT_PATH}/0/${idx}` };
}
