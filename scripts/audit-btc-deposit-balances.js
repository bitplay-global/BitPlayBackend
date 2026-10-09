#!/usr/bin/env node
/**
 * How much BTC is sitting on the deposit addresses right now?
 *
 * Uses Bitcoin Core's scantxoutset, which reads the node's current UTXO set
 * and therefore works on a pruned node (unlike a wallet rescan). Scans:
 *   - the ranged descriptor of the deposit account key (every address it
 *     ever produced or will produce), and
 *   - every stored address that key does NOT produce, individually.
 * Then joins each funded output with the stored address record and any
 * deposit record for that txid, so unrecorded or uncredited money stands out.
 *
 * Read-only. Prints addresses and amounts, never keys.
 *
 *   node scripts/audit-btc-deposit-balances.js --env /home/pi/btc-original-key.env
 *   node scripts/audit-btc-deposit-balances.js            # keys from .env
 *
 * scantxoutset walks the whole UTXO set (a minute or two on mainnet).
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
  const r = dotenv.config({ path: path.resolve(argv[envIdx + 1] || ''), override: true });
  if (r.error) { console.error(r.error.message); process.exit(2); }
}
const RPC_HOST = process.env.BTC_RPC_HOST || '127.0.0.1', RPC_PORT = process.env.BTC_RPC_PORT || '8332';
const RPC_USER = process.env.BTC_RPC_USER, RPC_PASS = process.env.BTC_RPC_PASS;
if (!RPC_USER || !RPC_PASS) { console.error('BTC_RPC_USER / BTC_RPC_PASS must be set'); process.exit(2); }
async function rpc(method, params = []) {
  const res = await fetch(`http://${RPC_HOST}:${RPC_PORT}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64') },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
  return j.result;
}

const bip32 = BIP32Factory(ecc);
const net = bitcoin.networks.bitcoin;
const p2wpkh = n => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(n.publicKey), network: net }).address;

// Account key, however the env expresses it.
let account = null, how = '';
if (process.env.BTC_XPRV) {
  const k = bip32.fromBase58(process.env.BTC_XPRV, net);
  account = k.depth === 0 ? k.derivePath("84'/0'/0'").neutered() : k.neutered();
  how = k.depth === 0 ? "BTC_XPRV root -> m/84'/0'/0'" : `BTC_XPRV depth ${k.depth} used as the account`;
} else if (process.env.BTC_XPUB) {
  account = bip32.fromBase58(process.env.BTC_XPUB, net); how = 'BTC_XPUB';
}
if (!account) { console.error('No BTC_XPRV / BTC_XPUB'); process.exit(2); }
console.log(`account key from: ${how}`);

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection;
const stored = await db.collection('walletaddresses').find({ chain: 'btc' }).project({ address: 1, idx: 1, userId: 1 }).toArray();
const byAddr = new Map(stored.map(a => [a.address, a]));

// Which stored addresses does the account key produce? (so the rest get addr() descriptors)
const RANGE = 2000;
const produced = new Set();
for (let i = 0; i < RANGE; i++) produced.add(p2wpkh(account.derivePath(`0/${i}`)));
const extra = stored.filter(a => !produced.has(a.address) && /^bc1q/.test(a.address));
const skipped = stored.filter(a => !produced.has(a.address) && !/^bc1q/.test(a.address));
console.log(`stored: ${stored.length}; produced by this key: ${stored.filter(a => produced.has(a.address)).length}; scanned individually: ${extra.length}; skipped (not mainnet segwit): ${skipped.length}`);

const descs = [{ desc: (await rpc('getdescriptorinfo', [`wpkh(${account.toBase58()}/0/*)`])).descriptor, range: [0, RANGE] }];
for (const a of extra) descs.push((await rpc('getdescriptorinfo', [`addr(${a.address})`])).descriptor);

console.log('scanning the UTXO set (this takes a minute or two)...');
const scan = await rpc('scantxoutset', ['start', descs]);
if (!scan?.success) throw new Error('scantxoutset did not succeed');

const deposits = db.collection('deposits');
const rows = [];
for (const u of scan.unspents) {
  let address = '?'; try { address = bitcoin.address.fromOutputScript(Buffer.from(u.scriptPubKey, 'hex'), net); } catch { /* keep ? */ }
  const rec = byAddr.get(address);
  const dep = await deposits.findOne({ txHash: u.txid, chain: 'btc' }, { projection: { credited: 1, orphaned: 1, user: 1 } });
  rows.push({ address, idx: rec?.idx ?? '-', user: rec?.userId ?? '(no record)', txid: u.txid, vout: u.vout, amount: u.amount, height: u.height,
    status: !dep ? 'NOT RECORDED' : dep.orphaned ? 'orphaned' : dep.credited ? 'credited' : 'UNCREDITED' });
}
rows.sort((a, b) => (a.idx === '-' ? 1e9 : a.idx) - (b.idx === '-' ? 1e9 : b.idx));
console.log(`\nfunded outputs: ${rows.length}   total: ${scan.total_amount} BTC   (UTXO set at height ${scan.height})\n`);
if (rows.length) {
  console.log(' idx  address                                       amount(BTC)   height    status        txid');
  for (const r of rows) console.log(` ${String(r.idx).padStart(3)}  ${r.address.padEnd(44)} ${String(r.amount).padStart(12)}  ${String(r.height).padStart(7)}  ${r.status.padEnd(12)}  ${r.txid.slice(0, 16)}…  user ${r.user}`);
}
const byStatus = rows.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + r.amount, m), {});
console.log('\nby status (BTC):', byStatus);
await mongoose.disconnect();
