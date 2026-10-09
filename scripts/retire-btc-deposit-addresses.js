#!/usr/bin/env node
/**
 * Retire BTC deposit addresses that were not derived from the current deposit
 * key, so each affected user is issued a fresh address on their next request.
 *
 * "Current key" is resolved exactly as the deposit route does (BTC_XPUB /
 * BTC_XPRV, see helpers/btcDepositKey.js). An address is kept active only if
 * the current account key produces it at its stored idx. Everything else
 * (addresses from a replaced master key, early Bitcoin Core wallets, testnet
 * test records) is marked retiredAt/retiredReason.
 *
 * Retired records are NOT deleted: the deposit watcher still detects and
 * attributes late deposits to them (funds there are spendable only with the
 * key that produced them). Nothing on-chain changes and no balance is touched.
 *
 *   node scripts/retire-btc-deposit-addresses.js            # dry run: list what would change
 *   node scripts/retire-btc-deposit-addresses.js --apply    # mark them retired
 *
 * Deploy the route that skips retired addresses BEFORE --apply, or users will
 * keep being shown the old address.
 */
import '../config/loadEnv.js';
import mongoose from 'mongoose';
import { resolveBtcAccount, deriveBtcAddress } from '../helpers/btcDepositKey.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
for (const a of argv) if (a !== '--apply') { console.error(`Unknown option ${a}`); process.exit(2); }
const REASON = 'derived from a replaced deposit key; reissued from the current key';

const key = resolveBtcAccount({ xprv: process.env.BTC_XPRV, xpub: process.env.BTC_XPUB });
if (key.error) { console.error(`Cannot resolve the current deposit key: ${key.error}`); process.exit(2); }
console.log(`current deposit key: ${key.source} (account m/84'/0'/0')`);

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection;
const col = db.collection('walletaddresses');

const active = await col.find({ chain: 'btc', retiredAt: null })
  .project({ address: 1, idx: 1, userId: 1, created_at: 1, createdAt: 1 }).sort({ idx: 1 }).toArray();

const fromCurrentKey = a => {
  if (!Number.isInteger(a.idx)) return false;
  try { return deriveBtcAddress(key.account, a.idx).address === a.address; } catch { return false; }
};
const keep = active.filter(fromCurrentKey);
const retire = active.filter(a => !fromCurrentKey(a));

// Annotate: does the owner still exist, and has anything ever been deposited here?
const users = db.collection('users');
const deposits = db.collection('deposits');
const when = a => (a.created_at || a.createdAt || a._id.getTimestamp()).toISOString().slice(0, 10);
let ownersFound = 0, withDeposits = 0;
console.log(`\nactive BTC addresses: ${active.length}   keep (current key): ${keep.length}   retire: ${retire.length}\n`);
if (retire.length) console.log(' idx  address                                       created     owner        deposits');
for (const a of retire) {
  const id = String(a.userId);
  const owner = await users.findOne(
    /^[0-9a-fA-F]{24}$/.test(id) ? { _id: new mongoose.Types.ObjectId(id) } : { firebase_uid: id },
    { projection: { _id: 1 } },
  );
  if (owner) ownersFound++;
  const n = await deposits.countDocuments({ chain: 'btc', address: a.address });
  if (n) withDeposits++;
  console.log(` ${String(a.idx).padStart(3)}  ${a.address.padEnd(44)}  ${when(a)}  ${(owner ? 'exists' : 'not found').padEnd(11)}  ${n}`);
}
if (retire.length) console.log(`\nowners still present: ${ownersFound}/${retire.length}; addresses with recorded deposits: ${withDeposits}`);

if (!APPLY) {
  console.log('\nDry run, nothing changed. Re-run with --apply to retire these addresses.');
  await mongoose.disconnect();
  process.exit(0);
}
if (!retire.length) { console.log('Nothing to retire.'); await mongoose.disconnect(); process.exit(0); }

const r = await col.updateMany(
  { _id: { $in: retire.map(a => a._id) }, retiredAt: null },
  { $set: { retiredAt: new Date(), retiredReason: REASON } },
);
console.log(`\nretired ${r.modifiedCount} address(es). Each affected user gets a new address from the current key on their next deposit-screen visit.`);
await mongoose.disconnect();
