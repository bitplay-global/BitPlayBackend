#!/usr/bin/env node
/**
 * Which key were the BTC deposit addresses actually derived from?
 *
 * The deposit route derives address idx as m/84'/0'/0'/0/idx from BTC_XPRV,
 * or as <BTC_XPUB>/0/idx when BTC_XPUB is set (it is then assumed to be the
 * account node m/84'/0'/0'). If BTC_XPUB is not that exact account key, new
 * addresses silently come from a different key than old ones, and funds sent
 * to them cannot be spent with the keys the sweeping tools derive.
 *
 * This re-derives every stored BTC address from each configured key and says
 * which one matches. Read-only; prints addresses and booleans, never keys.
 *
 *   node scripts/check-btc-deposit-key.js
 */
import '../config/loadEnv.js';
import mongoose from 'mongoose';
import BIP32Factory from 'bip32';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';

const bip32 = BIP32Factory(ecc);
const net = bitcoin.networks.bitcoin;
const p2wpkh = node => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(node.publicKey), network: net }).address;

const xprvRoot = process.env.BTC_XPRV ? bip32.fromBase58(process.env.BTC_XPRV, net) : null;
const xpubNode = process.env.BTC_XPUB ? bip32.fromBase58(process.env.BTC_XPUB, net) : null;
if (!xprvRoot && !xpubNode) { console.error('Neither BTC_XPRV nor BTC_XPUB is set'); process.exit(2); }

const fromXprv = idx => xprvRoot ? p2wpkh(xprvRoot.derivePath(`84'/0'/0'/0/${idx}`)) : null;
const fromXpub = idx => xpubNode ? p2wpkh(xpubNode.derivePath(`0/${idx}`)) : null;

if (xprvRoot && xpubNode) {
  const acct = xprvRoot.derivePath("84'/0'/0'").neuter().toBase58();
  console.log(`BTC_XPUB equals the m/84'/0'/0' account key of BTC_XPRV: ${acct === xpubNode.toBase58() ? 'YES' : 'NO'}`);
  console.log(`BTC_XPUB depth: ${xpubNode.depth} (3 = account level as expected, 0 = root key)`);
}
console.log(`route currently derives new addresses from: ${process.env.BTC_XPUB ? 'BTC_XPUB' : 'BTC_XPRV'}`);

await mongoose.connect(process.env.MONGODB_URI);
const addrs = await mongoose.connection.collection('walletaddresses')
  .find({ chain: 'btc' }).project({ address: 1, idx: 1, userId: 1, createdAt: 1 }).sort({ idx: 1 }).toArray();
const counts = { xprv: 0, xpub: 0, neither: 0, noIdx: 0 };
console.log('\n idx  address                                      xprv  xpub');
for (const a of addrs) {
  if (!Number.isInteger(a.idx)) { counts.noIdx++; continue; }
  const mXprv = fromXprv(a.idx) === a.address;
  const mXpub = fromXpub(a.idx) === a.address;
  if (mXprv) counts.xprv++; else if (mXpub) counts.xpub++; else counts.neither++;
  console.log(` ${String(a.idx).padStart(3)}  ${a.address.padEnd(44)} ${mXprv ? ' yes' : '  no'}  ${mXpub ? ' yes' : '  no'}`);
}
console.log(`\nmatched BTC_XPRV: ${counts.xprv}   matched BTC_XPUB: ${counts.xpub}   neither: ${counts.neither}   no idx: ${counts.noIdx}   total: ${addrs.length}`);
if (counts.neither) console.log('"neither" addresses were issued from a key that is not in .env (older deployment, testnet, or hand-made records).');
await mongoose.disconnect();
