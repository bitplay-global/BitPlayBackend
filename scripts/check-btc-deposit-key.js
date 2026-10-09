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
if (xprv && xpub) {
  const acct = xprv.derivePath("84'/0'/0'").neutered().toBase58();
  console.log(`BTC_XPUB equals the m/84'/0'/0' account key of BTC_XPRV: ${acct === xpub.toBase58() ? 'YES' : 'NO'}`);
}
console.log(`route derives new addresses from: ${process.env.BTC_XPUB ? 'BTC_XPUB' : 'BTC_XPRV'}`);

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
}

await mongoose.connect(process.env.MONGODB_URI);
const addrs = await mongoose.connection.collection('walletaddresses')
  .find({ chain: 'btc' }).project({ address: 1, idx: 1, createdAt: 1, _id: 1 }).sort({ idx: 1 }).toArray();
const when = a => (a.createdAt ? new Date(a.createdAt) : a._id?.getTimestamp?.())?.toISOString?.().slice(0, 10) ?? '?';
if (addrs.length) console.log(`stored BTC addresses: ${addrs.length}, idx ${addrs[0].idx}..${addrs[addrs.length - 1].idx}, created ${when(addrs[0])} .. ${when(addrs[addrs.length - 1])}`);

const hits = Object.fromEntries(layouts.map(l => [l.name, 0]));
const unmatched = [];
for (const a of addrs) {
  if (!Number.isInteger(a.idx)) continue;
  let matched = false;
  for (const l of layouts) {
    let d; try { d = l.f(a.idx); } catch { continue; }
    if (d === a.address) { hits[l.name]++; matched = true; }
  }
  if (!matched) unmatched.push(a);
}
console.log('\nmatches per layout:');
for (const [name, n] of Object.entries(hits)) console.log(`  ${name.padEnd(30)} ${n}`);
console.log(`unmatched: ${unmatched.length} of ${addrs.length}`);
if (unmatched.length && unmatched.length <= 12) for (const a of unmatched) console.log(`  idx ${a.idx}  ${a.address}  (${when(a)})`);

if (xprv) {
  console.log(`\nIf BTC_XPRV is the key to keep, BTC_XPUB must be its account key (public, safe to copy):`);
  console.log(`BTC_XPUB=${xprv.derivePath("84'/0'/0'").neutered().toBase58()}`);
}
await mongoose.disconnect();
