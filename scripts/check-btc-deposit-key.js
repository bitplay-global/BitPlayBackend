#!/usr/bin/env node
/**
 * Which key were the BTC deposit addresses actually derived from?
 *
 * The deposit route derives address idx as m/84'/0'/0'/0/idx from BTC_XPRV,
 * or as <BTC_XPUB>/0/idx when BTC_XPUB is set (it is then assumed to be the
 * account node m/84'/0'/0'). If the keys in .env are not the ones the stored
 * addresses came from, deposits to those addresses cannot be spent from this
 * server, and new addresses may be issued from a key nobody holds.
 *
 * This re-derives every stored BTC address from each configured key, trying
 * the route's layout and a few common alternatives, and reports what matches.
 * Read-only; prints addresses, depths and booleans, never private keys. The
 * one key it prints is the PUBLIC account key of BTC_XPRV, which is what
 * BTC_XPUB should be set to.
 *
 *   node scripts/check-btc-deposit-key.js                 # keys from .env
 *   node scripts/check-btc-deposit-key.js --env .env.bak  # keys from another env file
 */
import '../config/loadEnv.js';
import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';
import BIP32Factory from 'bip32';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { resolveBtcAccount } from '../helpers/btcDepositKey.js';

const argv = process.argv.slice(2);
const envIdx = argv.indexOf('--env');
if (envIdx !== -1) {
  const file = path.resolve(argv[envIdx + 1] || '');
  const r = dotenv.config({ path: file, override: true });
  if (r.error) { console.error(`Cannot read ${file}: ${r.error.message}`); process.exit(2); }
  console.log(`keys loaded from: ${file}`);
} else {
  console.log('keys loaded from: .env');
}

const bip32 = BIP32Factory(ecc);
const net = bitcoin.networks.bitcoin;
const p2wpkh = node => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(node.publicKey), network: net }).address;
const tryNode = (label, b58) => {
  if (!b58) return null;
  try { return bip32.fromBase58(b58, net); } catch (e) { console.log(`${label}: cannot parse (${e.message})`); return null; }
};

const xprv = tryNode('BTC_XPRV', process.env.BTC_XPRV);
const xpub = tryNode('BTC_XPUB', process.env.BTC_XPUB);
if (!xprv && !xpub) { console.error('Neither BTC_XPRV nor BTC_XPUB is set/parseable in that file'); process.exit(2); }
if (xprv) console.log(`BTC_XPRV: depth ${xprv.depth} (0 = root/master key, 3 = account key), private=${!xprv.isNeutered()}`);
if (xpub) console.log(`BTC_XPUB: depth ${xpub.depth} (3 = account key as expected), private=${!xpub.isNeutered()}`);
// Same resolution the deposit route uses (root or account-level xprv).
const resolved = resolveBtcAccount({ xprv: process.env.BTC_XPRV, xpub: process.env.BTC_XPUB });
if (xprv && xpub) console.log(`BTC_XPUB and BTC_XPRV describe the same account: ${resolved.error ? 'NO' : 'YES'}`);
console.log(resolved.error
  ? `route would REFUSE to issue BTC addresses: ${resolved.error}`
  : `route derives new addresses from: ${resolved.source}`);

// Derivation layouts to test. "route" is what alchemy_deposit.js does.
const layouts = [];
if (xprv) {
  layouts.push({ name: "xprv route 84'/0'/0'/0/i", f: i => p2wpkh(xprv.derivePath(`84'/0'/0'/0/${i}`)) });
  layouts.push({ name: 'xprv as account 0/i', f: i => p2wpkh(xprv.derivePath(`0/${i}`)) });
  layouts.push({ name: "xprv 44'/0'/0'/0/i", f: i => p2wpkh(xprv.derivePath(`44'/0'/0'/0/${i}`)) });
  layouts.push({ name: "xprv 84'/0'/0'/i", f: i => p2wpkh(xprv.derivePath(`84'/0'/0'/${i}`)) });
}
if (xpub) {
  layouts.push({ name: 'xpub route 0/i', f: i => p2wpkh(xpub.derivePath(`0/${i}`)) });
  layouts.push({ name: 'xpub i', f: i => p2wpkh(xpub.derive(i)) });
  layouts.push({ name: 'xpub 1/i (change chain)', f: i => p2wpkh(xpub.derivePath(`1/${i}`)) });
  layouts.push({ name: 'xpub 0/0/i', f: i => p2wpkh(xpub.derivePath(`0/0/${i}`)) });
  layouts.push({ name: 'xpub i/0', f: i => p2wpkh(xpub.derivePath(`${i}/0`)) });
}

await mongoose.connect(process.env.MONGODB_URI);
const addrs = await mongoose.connection.collection('walletaddresses')
  .find({ chain: 'btc' }).project({ address: 1, idx: 1, createdAt: 1, _id: 1 }).sort({ idx: 1 }).toArray();
const when = a => (a.createdAt ? new Date(a.createdAt) : a._id?.getTimestamp?.())?.toISOString?.().slice(0, 10) ?? '?';
if (addrs.length) console.log(`stored BTC addresses: ${addrs.length}, idx ${addrs[0].idx}..${addrs[addrs.length - 1].idx}, created ${when(addrs[0])} .. ${when(addrs[addrs.length - 1])}`);

// Index-independent search: derive the first SCAN addresses of every layout
// and look each stored address up. Catches the case where the stored idx is
// not the index that was actually used.
const SCAN = 2000;
const table = new Map(); // address -> { layout, i }
for (const l of layouts) {
  for (let i = 0; i < SCAN; i++) {
    let d; try { d = l.f(i); } catch { break; }
    if (!table.has(d)) table.set(d, { layout: l.name, i });
  }
}
const hits = Object.fromEntries(layouts.map(l => [l.name, { sameIdx: 0, otherIdx: 0 }]));
const unmatched = [], matched = [];
for (const a of addrs) {
  const m = table.get(a.address);
  if (!m) { unmatched.push(a); continue; }
  if (m.i === a.idx) hits[m.layout].sameIdx++; else hits[m.layout].otherIdx++;
  matched.push({ ...a, layout: m.layout, realIdx: m.i });
}
console.log(`\nmatches per layout (searching indexes 0..${SCAN - 1}):`);
for (const [name, h] of Object.entries(hits)) console.log(`  ${name.padEnd(30)} at stored idx: ${h.sameIdx}   at a different index: ${h.otherIdx}`);
if (matched.length) {
  console.log('matched addresses (stored idx -> index that produces it):');
  for (const s of matched.slice(0, 70)) console.log(`  stored ${String(s.idx).padStart(3)} -> real ${String(s.realIdx).padStart(4)}  ${s.address}  (${s.layout}, ${when(s)})`);
}
console.log(`unmatched: ${unmatched.length} of ${addrs.length}`);
if (unmatched.length && unmatched.length <= 70) for (const a of unmatched) console.log(`  idx ${String(a.idx).padStart(3)}  ${a.address}  (${when(a)})`);

if (xprv && !resolveBtcAccount({ xprv: process.env.BTC_XPRV }).error) {
  console.log(`\nIf BTC_XPRV is the key to keep, BTC_XPUB must be its account key (public, safe to copy):`);
  console.log(`BTC_XPUB=${resolveBtcAccount({ xprv: process.env.BTC_XPRV }).account.toBase58()}`);
}
await mongoose.disconnect();
