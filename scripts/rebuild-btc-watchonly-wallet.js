#!/usr/bin/env node
/**
 * Rebuild the Bitcoin Core watch-only wallet the deposit watcher reads from.
 *
 * Why this exists: the node is pruned. If the `watchonly` wallet is ever left
 * unloaded for longer than the retained blocks cover, Bitcoin Core refuses to
 * load it again ("last wallet synchronisation goes beyond pruned data") and
 * the only official remedy is a multi-day reindex. Deposits stop being
 * credited meanwhile.
 *
 * This script creates a fresh descriptor wallet with the same name and
 * imports ONE ranged descriptor derived from the deposit account key
 * (BTC_XPUB, or BTC_XPRV which is neutered in memory), so the wallet knows
 * every deposit address ever issued and every one that will be issued, with
 * no per-address import step. The wallet is marked load_on_startup so a node
 * restart cannot leave it unloaded again.
 *
 * Run on the server as the user that owns bitcoind, from the backend dir:
 *
 *   node scripts/rebuild-btc-watchonly-wallet.js            # plan only, changes nothing
 *   node scripts/rebuild-btc-watchonly-wallet.js --apply    # create + import + verify
 *   node scripts/rebuild-btc-watchonly-wallet.js --apply --rename-old
 *       # also moves an unloadable wallet dir of the same name out of the way
 *
 * Env: BTC_XPUB (or BTC_XPRV), BTC_WALLET (default watchonly), BTC_RPC_USER,
 * BTC_RPC_PASS, BTC_RPC_HOST (127.0.0.1), BTC_RPC_PORT (8332), BITCOIN_DATADIR
 * (default ~/.bitcoin, only used by --rename-old), MONGODB_URI.
 *
 * Only the retained (unpruned) blocks are rescanned. Deposits that confirmed
 * before that window must be credited with scripts/credit-btc-deposit.js.
 */
import '../config/loadEnv.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';
import BIP32Factory from 'bip32';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const RENAME_OLD = args.has('--rename-old');
for (const a of args) if (!['--apply', '--rename-old'].includes(a)) { console.error(`Unknown option ${a}`); process.exit(2); }

const WALLET = process.env.BTC_WALLET || 'watchonly';
const RPC_HOST = process.env.BTC_RPC_HOST || '127.0.0.1';
const RPC_PORT = process.env.BTC_RPC_PORT || '8332';
const RPC_USER = process.env.BTC_RPC_USER;
const RPC_PASS = process.env.BTC_RPC_PASS;
if (!RPC_USER || !RPC_PASS) { console.error('BTC_RPC_USER and BTC_RPC_PASS must be set in .env'); process.exit(2); }

async function rpc(method, params = [], wallet = null) {
  const url = `http://${RPC_HOST}:${RPC_PORT}/${wallet ? `wallet/${wallet}` : ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64'),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !json.error) throw new Error(`RPC HTTP ${res.status} for ${method}`);
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message} (code ${json.error.code})`);
  return json.result;
}

function accountXpub() {
  const bip32 = BIP32Factory(ecc);
  const net = bitcoin.networks.bitcoin;
  if (process.env.BTC_XPUB) {
    const node = bip32.fromBase58(process.env.BTC_XPUB, net);
    if (!node.isNeutered()) throw new Error('BTC_XPUB holds a private key; put it in BTC_XPRV instead');
    return node.toBase58();
  }
  if (process.env.BTC_XPRV) {
    const root = bip32.fromBase58(process.env.BTC_XPRV, net);
    // Same account node the deposit route derives from: m/84'/0'/0'
    return root.derivePath("84'/0'/0'").neuter().toBase58();
  }
  throw new Error('Neither BTC_XPUB nor BTC_XPRV is set');
}

async function main() {
  const xpub = accountXpub();
  const net = await rpc('getblockchaininfo');
  console.log(`node: chain=${net.chain} blocks=${net.blocks} pruned=${net.pruned} pruneheight=${net.pruneheight ?? '-'}`);
  if (net.chain !== 'main') throw new Error(`Expected mainnet, node is on ${net.chain}`);

  // Rescan window: everything the pruned node still holds. Core refuses a
  // timestamp older than its retained blocks (it also looks back a 2h safety
  // window), so start just after the oldest retained block.
  let timestamp = 'now';
  if (net.pruned && net.pruneheight) {
    const hash = await rpc('getblockhash', [net.pruneheight]);
    const hdr = await rpc('getblockheader', [hash]);
    timestamp = hdr.time + 2 * 3600 + 600;
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const addrs = await mongoose.connection.collection('walletaddresses')
    .find({ chain: 'btc' }).project({ address: 1, idx: 1, userId: 1 }).toArray();
  const maxIdx = addrs.reduce((m, a) => Math.max(m, Number(a.idx) || 0), 0);
  const range = Math.max(2000, maxIdx + 1000);

  const loaded = await rpc('listwallets');
  const onDisk = (await rpc('listwalletdir')).wallets.map(w => w.name);
  console.log(`wallet "${WALLET}": loaded=${loaded.includes(WALLET)} onDisk=${onDisk.includes(WALLET)}`);
  console.log(`deposit addresses in DB: ${addrs.length} (max idx ${maxIdx}); descriptor range 0..${range}`);
  console.log(`rescan from: ${timestamp === 'now' ? 'now (no rescan)' : new Date(timestamp * 1000).toISOString()}`);

  const { descriptor } = await rpc('getdescriptorinfo', [`wpkh(${xpub}/0/*)`]);
  console.log(`descriptor: ${descriptor}`);

  if (!APPLY) {
    console.log('\nPlan only. Re-run with --apply to create the wallet and import the descriptor.');
    await mongoose.disconnect();
    return;
  }

  if (loaded.includes(WALLET)) {
    // Already loaded: it is either a wallet this script created on an earlier
    // run that stopped before the import, or a healthy one. Only add the
    // descriptor if it is missing; never recreate.
    const info = await rpc('getwalletinfo', [], WALLET);
    if (!info.descriptors || info.private_keys_enabled) {
      throw new Error(`"${WALLET}" is loaded but is not a watch-only descriptor wallet; unload it and re-run with --rename-old`);
    }
    console.log(`"${WALLET}" is already loaded; checking its descriptors`);
  } else {
    if (onDisk.includes(WALLET)) {
      if (!RENAME_OLD) throw new Error(`A wallet named "${WALLET}" exists on disk but is not loaded. Re-run with --rename-old to move it aside, or move it yourself.`);
      const datadir = process.env.BITCOIN_DATADIR || path.join(os.homedir(), '.bitcoin');
      const from = path.join(datadir, 'wallets', WALLET);
      const to = `${from}.unloadable-${new Date().toISOString().slice(0, 10)}`;
      if (!fs.existsSync(from)) throw new Error(`Expected wallet dir at ${from}; set BITCOIN_DATADIR`);
      fs.renameSync(from, to);
      console.log(`moved old wallet dir -> ${to}`);
    }
    // createwallet(name, disable_private_keys, blank, passphrase, avoid_reuse, descriptors, load_on_startup)
    await rpc('createwallet', [WALLET, true, true, '', false, true, true]);
    console.log(`created descriptor wallet "${WALLET}" (watch-only, load_on_startup=true)`);
  }

  const bare = descriptor.replace(/#\w+$/, '');
  const existing = (await rpc('listdescriptors', [], WALLET)).descriptors.map(d => d.desc.replace(/#\w+$/, ''));
  if (existing.includes(bare)) {
    console.log('descriptor already present; skipping import');
  } else {
    // Note: Core rejects a `label` on a ranged descriptor.
    const result = await rpc('importdescriptors', [[{
      desc: descriptor, active: false, range: [0, range], timestamp, internal: false,
    }]], WALLET);
    if (!result?.[0]?.success) throw new Error(`importdescriptors failed: ${JSON.stringify(result)}`);
    console.log('descriptor imported' + (result[0].warnings?.length ? ` (warnings: ${result[0].warnings.join('; ')})` : ''));
  }

  // Verify every address the app ever issued is recognised by the wallet.
  // Addresses that pre-date the xpub scheme (or were issued from another
  // key) are imported one by one, because the API keeps returning a user's
  // existing address. Records that are not valid Bitcoin addresses at all
  // are reported and skipped.
  const legacy = [], invalid = [];
  let recognised = 0;
  for (const a of addrs) {
    let info;
    try { info = await rpc('getaddressinfo', [a.address], WALLET); }
    catch (e) { invalid.push(a); console.error(`  INVALID ADDRESS: "${a.address}" (idx ${a.idx}, user ${a.userId}): ${e.message}`); continue; }
    if (info.ismine) recognised++; else legacy.push(a);
  }
  if (legacy.length) {
    const reqs = [];
    for (const a of legacy) {
      const { descriptor: d } = await rpc('getdescriptorinfo', [`addr(${a.address})`]);
      reqs.push({ desc: d, timestamp });
    }
    const res = await rpc('importdescriptors', [reqs], WALLET);
    res.forEach((r, i) => {
      const a = legacy[i];
      if (r.success) { recognised++; console.log(`  imported legacy address ${a.address} (idx ${a.idx}, user ${a.userId})`); }
      else console.error(`  FAILED legacy import ${a.address} (idx ${a.idx}, user ${a.userId}): ${r.error?.message}`);
    });
  }
  const utxos = await rpc('listunspent', [0, 9999999], WALLET);
  console.log(`verified: ${recognised}/${addrs.length} addresses recognised (${legacy.length} legacy imported individually, ${invalid.length} invalid skipped); ${utxos.length} unspent output(s) visible in the retained blocks`);
  await mongoose.disconnect();
  if (recognised + invalid.length < addrs.length) { console.error('Some valid addresses are still not recognised; see FAILED lines above.'); process.exit(1); }
  console.log('\nDone. Restart the backend so the watcher reconnects: pm2 restart admin-panel');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
