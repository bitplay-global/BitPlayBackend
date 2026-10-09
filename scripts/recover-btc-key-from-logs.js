#!/usr/bin/env node
/**
 * Find the BTC deposit key the old deployment actually used, from its logs.
 *
 * The old deposit route logged `BTC_XPRV: <key>` on every address request.
 * That is a serious leak (fix: rotate the key once funds are moved), but it
 * is also the only remaining copy if the key in .env was replaced without
 * migrating. This scans pm2 log files for such lines, collects the distinct
 * keys, and tests each one against the stored deposit addresses using the
 * old route's derivation (m/84'/0'/0'/0/idx from the key as given).
 *
 * Prints, per distinct key: a short fingerprint (first/last 4 characters),
 * how many stored addresses it reproduces, and the dates it was seen. It
 * NEVER prints a key. With --save <file> it writes the best-matching key to
 * that file as `BTC_XPRV=...` with mode 0600, so the key never has to pass
 * through a terminal or chat.
 *
 *   node scripts/recover-btc-key-from-logs.js
 *   node scripts/recover-btc-key-from-logs.js --logs /home/pi/.pm2/logs --save /home/pi/btc-original-key.env
 */
import '../config/loadEnv.js';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import mongoose from 'mongoose';
import BIP32Factory from 'bip32';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1]; };
const LOG_DIRS = (opt('--logs', '/home/pi/.pm2/logs')).split(',');
const SAVE = opt('--save', null);

const bip32 = BIP32Factory(ecc);
const net = bitcoin.networks.bitcoin;
const KEY_RE = /BTC_XPRV:\s*(xprv[1-9A-HJ-NP-Za-km-z]{90,120})/g;
const DATE_RE = /\b(20\d\d-\d\d-\d\d)/;

const seen = new Map(); // key -> { first, last, count, files:Set }
function scanText(text, file) {
  let m;
  while ((m = KEY_RE.exec(text))) {
    const key = m[1];
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const line = text.slice(lineStart, text.indexOf('\n', m.index));
    const d = DATE_RE.exec(line)?.[1] ?? null;
    const e = seen.get(key) ?? { first: d, last: d, count: 0, files: new Set() };
    e.count++; e.files.add(path.basename(file));
    if (d) { if (!e.first || d < e.first) e.first = d; if (!e.last || d > e.last) e.last = d; }
    seen.set(key, e);
  }
}

let filesScanned = 0;
for (const dir of LOG_DIRS) {
  if (!fs.existsSync(dir)) { console.error(`no such dir: ${dir}`); continue; }
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (!fs.statSync(p).isFile()) continue;
    try {
      const raw = fs.readFileSync(p);
      const text = f.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
      scanText(text, p); filesScanned++;
    } catch (e) { console.error(`skip ${p}: ${e.message}`); }
  }
}
console.log(`scanned ${filesScanned} log file(s); distinct keys found: ${seen.size}`);
if (!seen.size) { console.log('No BTC_XPRV lines in these logs. Try --logs with other directories (rotated logs, backups).'); process.exit(0); }

await mongoose.connect(process.env.MONGODB_URI);
const addrs = await mongoose.connection.collection('walletaddresses').find({ chain: 'btc' }).project({ address: 1, idx: 1 }).toArray();
const fp = k => `${k.slice(0, 4)}…${k.slice(-4)}`;
let best = null;
for (const [key, e] of seen) {
  let node; try { node = bip32.fromBase58(key, net); } catch { console.log(`${fp(key)}: not a valid mainnet xprv`); continue; }
  let hits = 0;
  for (const a of addrs) {
    if (!Number.isInteger(a.idx)) continue;
    try {
      const addr = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(node.derivePath(`84'/0'/0'/0/${a.idx}`).publicKey), network: net }).address;
      if (addr === a.address) hits++;
    } catch { /* ignore */ }
  }
  const sameAsEnv = process.env.BTC_XPRV === key;
  console.log(`${fp(key)}: depth ${node.depth}, seen ${e.count}x in ${[...e.files].join(', ')} (${e.first ?? '?'} .. ${e.last ?? '?'}), reproduces ${hits}/${addrs.length} stored addresses${sameAsEnv ? '  [this is the key currently in .env]' : ''}`);
  if (!best || hits > best.hits) best = { key, hits };
}
await mongoose.disconnect();

if (best && best.hits > 0) {
  console.log(`\nbest match: ${fp(best.key)} reproduces ${best.hits}/${addrs.length} addresses.`);
  if (SAVE) {
    fs.writeFileSync(SAVE, `BTC_XPRV=${best.key}\n`, { mode: 0o600 });
    console.log(`saved to ${SAVE} (mode 600). Verify with: node scripts/check-btc-deposit-key.js --env ${SAVE}`);
  } else {
    console.log('Re-run with --save <file> to write it to a private file (never paste it into a chat or ticket).');
  }
} else {
  console.log('\nNone of the logged keys reproduce the stored addresses.');
}
