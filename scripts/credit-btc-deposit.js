#!/usr/bin/env node
/**
 * Credit one BTC deposit that the watcher recorded but never credited.
 *
 * Needed for deposits that confirmed while the node's watch-only wallet was
 * unloaded: the pruned node no longer holds those blocks, so the watcher can
 * never see them again. The operator confirms the transaction on a block
 * explorer and passes the confirmation count.
 *
 * Run on the server from the backend dir:
 *
 *   node scripts/credit-btc-deposit.js --tx <txid>                     # dry run
 *   node scripts/credit-btc-deposit.js --tx <txid> --confirmations 6 --apply
 *
 * It finds the deposit record, resolves the owner from the deposit address,
 * marks the record credited, and adds the amount to the user's BTC_DEPOSIT
 * balance exactly as webhooks/btcWatcher.js would have. Nothing is swept and
 * no subscription plan is marked paid; do those by hand if they apply.
 */
import '../config/loadEnv.js';
import mongoose from 'mongoose';

function parseArgs(argv) {
  const a = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--tx') { a.tx = v; i++; }
    else if (k === '--confirmations') { a.confirmations = Number(v); i++; }
    else if (k === '--apply') a.apply = true;
    else throw new Error(`Unknown option: ${k}`);
  }
  if (!/^[0-9a-f]{64}$/i.test(a.tx || '')) throw new Error('Give --tx <64-hex txid>');
  if (a.apply && !(Number.isInteger(a.confirmations) && a.confirmations >= 1)) throw new Error('--apply needs --confirmations <n>, verified on a block explorer');
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection;
  const deposits = db.collection('deposits');

  const dep = await deposits.findOne({ txHash: a.tx.toLowerCase(), chain: 'btc' });
  if (!dep) throw new Error('No BTC deposit record with that txid');
  const amount = Number(dep.amountNumeric?.toString?.() ?? dep.amountNumeric);
  console.log(`deposit: ${dep.txHash} vout ${dep.vout ?? 0} -> ${dep.address}  ${amount} BTC  recorded ${dep.createdAt?.toISOString?.() ?? dep.createdAt}`);
  console.log(`status : credited=${dep.credited === true} confirmations=${dep.confirmations ?? 0} owner=${dep.user || '(none)'}`);
  console.log(`check  : https://mempool.space/tx/${dep.txHash}`);

  if (dep.credited) { console.log('Already credited; nothing to do.'); return mongoose.disconnect(); }

  let rawOwner = dep.user;
  if (!rawOwner) {
    const rec = await db.collection('walletaddresses').findOne({ chain: 'btc', address: dep.address });
    rawOwner = rec?.userId;
  }
  if (!rawOwner) throw new Error(`No user owns address ${dep.address}; cannot credit`);

  // Address records may hold either the account's Mongo id or its Firebase
  // uid. Balances are keyed by the Mongo id, so resolve to that.
  const users = db.collection('users');
  let owner = null;
  if (/^[0-9a-fA-F]{24}$/.test(String(rawOwner))) {
    owner = await users.findOne({ _id: new mongoose.Types.ObjectId(String(rawOwner)) }, { projection: { email: 1, firebase_uid: 1 } });
  }
  if (!owner) owner = await users.findOne({ firebase_uid: String(rawOwner) }, { projection: { email: 1, firebase_uid: 1 } });
  if (!owner) throw new Error(`Address owner "${rawOwner}" matches no user by _id or firebase_uid; cannot credit`);
  const user = String(owner._id);
  console.log(`owner  : ${user}${owner.email ? ` (${owner.email})` : ''}${user !== String(rawOwner) ? `  [resolved from ${rawOwner}]` : ''}`);

  if (!a.apply) { console.log('\nDry run. Re-run with --confirmations <n> --apply to credit.'); return mongoose.disconnect(); }

  const now = new Date();
  const r = await deposits.updateOne(
    { _id: dep._id, credited: { $ne: true } },
    { $set: { user, confirmations: a.confirmations, credited: true, creditedAt: now } },
  );
  if (r.modifiedCount !== 1) throw new Error('Deposit was credited by something else meanwhile; balance NOT changed');
  await db.collection('balances').updateOne(
    { user },
    { $inc: { BTC_DEPOSIT: mongoose.Types.Decimal128.fromString(amount.toFixed(8)) } },
    { upsert: true },
  );
  const bal = await db.collection('balances').findOne({ user }, { projection: { BTC_DEPOSIT: 1 } });
  console.log(`credited ${amount.toFixed(8)} BTC to user ${user}; BTC_DEPOSIT is now ${bal?.BTC_DEPOSIT?.toString?.()}`);
  await mongoose.disconnect();
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
