#!/usr/bin/env node
/**
 * Resets wallets holding BTC their mining never produced (balances forged in
 * May-Aug 2026, when the app could tell the server what a user had mined).
 * Run on the server, from the backend folder:
 *
 *   node scripts/reset-fake-balances.js --user <id> --user <id>           (preview)
 *   node scripts/reset-fake-balances.js --user <id> --user <id> --apply   (reset)
 *
 * For each named user, what the wallet can honestly hold is worked out from
 * the daily settlements (BalanceHistory, one row per mined day):
 *
 *   supported = sum of settled days  -  BTC already withdrawn
 *
 * A settled day above the server's daily ceiling (maxSettlementBtcPerDay)
 * could not have been mined and is left out. The wallet is then set to
 *   BTC_DEPOSIT = min(current, supported),  BTC = 0
 * so a reset can only ever lower a balance. Other fields (USDT, USDC, BNB,
 * LTC) can come from real crypto deposits and are shown, never changed.
 *
 * Every reset is recorded in the `balanceadjustments` collection with the
 * old and new figures, so it can be reviewed or undone. The update only
 * applies if the wallet still holds what the preview read; anything that
 * changed in between is skipped.
 */
import '../config/loadEnv.js';
import mongoose from 'mongoose';
import { maxSettlementBtcPerDay } from '../helpers/miningDaySettlement.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const PAID_OR_PENDING = ['PENDING', 'APPROVED', 'SENT', 'CONFIRMED'];

function parseArgs(argv) {
  const a = { users: [], apply: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--user') a.users.push(String(argv[++i] || '').toLowerCase());
    else if (k === '--apply') a.apply = true;
    else throw new Error(`Unknown option: ${k}`);
  }
  if (!a.users.length) throw new Error('Name each wallet to reset with --user <userId>.');
  for (const u of a.users) if (!OBJECT_ID.test(u)) throw new Error(`Not a user id: ${u}`);
  return a;
}

const num = v => {
  const n = Number(v?.toString?.() ?? v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const btc = n => n.toFixed(10);

/** What the wallet can honestly hold, from settled days and withdrawals. */
export async function assess(db, userId, ceiling = maxSettlementBtcPerDay()) {
  const balance = await db.collection('balances').findOne({ user: userId });
  const days = await db.collection('balancehistories').find({ user: userId }, { projection: { date: 1, 'balances.BTC': 1 } }).toArray();
  let settled = 0, implausible = 0, implausibleBtc = 0;
  for (const d of days) {
    const v = num(d.balances?.BTC);
    if (v > ceiling) { implausible++; implausibleBtc += v; } else settled += v;
  }
  let withdrawn = 0;
  for (const w of await db.collection('withdrawals').find({ userId, status: { $in: PAID_OR_PENDING } }, { projection: { defaultAmountNumeric: 1 } }).toArray()) {
    withdrawn += num(w.defaultAmountNumeric);
  }
  const supported = Math.max(0, settled - withdrawn);
  const before = { BTC: num(balance?.BTC), BTC_DEPOSIT: num(balance?.BTC_DEPOSIT) };
  const after = { BTC: 0, BTC_DEPOSIT: Math.min(before.BTC_DEPOSIT, supported) };
  const others = Object.fromEntries(['USDT', 'USDC', 'BNB', 'LTC'].map(k => [k, num(balance?.[k])]).filter(([, v]) => v));
  return {
    userId, found: !!balance, rawBTC: balance?.BTC, rawDeposit: balance?.BTC_DEPOSIT,
    days: days.length, settled, implausible, implausibleBtc, withdrawn, supported, before, after, others,
    removes: before.BTC + before.BTC_DEPOSIT - after.BTC_DEPOSIT,
  };
}

export async function reset(db, a, reason) {
  if (!a.found || a.removes <= 0) return 'nothing to remove';
  const { insertedId } = await db.collection('balanceadjustments').insertOne({
    user: a.userId, kind: 'reset-fake-balance', reason, at: new Date(),
    before: { BTC: String(a.rawBTC ?? 0), BTC_DEPOSIT: String(a.rawDeposit ?? 0) },
    after: { BTC: '0', BTC_DEPOSIT: btc(a.after.BTC_DEPOSIT) },
    evidence: { settledDays: a.days, settledBtc: a.settled, implausibleDays: a.implausible, implausibleBtc: a.implausibleBtc, withdrawnBtc: a.withdrawn },
    applied: false,
  });
  // Only if the wallet still holds exactly what was assessed.
  const r = await db.collection('balances').updateOne(
    { user: a.userId, BTC: a.rawBTC, BTC_DEPOSIT: a.rawDeposit },
    { $set: { BTC: mongoose.Types.Decimal128.fromString('0'), BTC_DEPOSIT: mongoose.Types.Decimal128.fromString(btc(a.after.BTC_DEPOSIT)) } },
  );
  if (r.modifiedCount !== 1) {
    await db.collection('balanceadjustments').deleteOne({ _id: insertedId });
    return 'SKIPPED: the wallet changed since it was read -- run again';
  }
  await db.collection('balanceadjustments').updateOne({ _id: insertedId }, { $set: { applied: true } });
  return `reset (record ${insertedId})`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set (.env next to server.js).');
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  console.log(args.apply ? '\nRESETTING\n' : '\nPREVIEW (nothing is changed; add --apply to reset)\n');
  let total = 0;
  for (const userId of args.users) {
    const a = await assess(db, userId);
    if (!a.found) { console.log(`  ${userId}: no wallet\n`); continue; }
    console.log(`  ${userId}`);
    console.log(`     wallet now        BTC ${btc(a.before.BTC)} + BTC_DEPOSIT ${btc(a.before.BTC_DEPOSIT)}`);
    console.log(`     mined (${a.days} settled day(s))  ${btc(a.settled)}${a.implausible ? `   [left out: ${a.implausible} day(s) above the daily ceiling, ${btc(a.implausibleBtc)} BTC]` : ''}`);
    console.log(`     withdrawn/pending ${btc(a.withdrawn)}`);
    console.log(`     wallet after      BTC 0 + BTC_DEPOSIT ${btc(a.after.BTC_DEPOSIT)}   (removes ${btc(a.removes)} BTC)`);
    if (Object.keys(a.others).length) console.log(`     not changed       ${JSON.stringify(a.others)}  -- may be real deposits; check by hand`);
    if (args.apply) console.log(`     -> ${await reset(db, a, 'balance not supported by mining history')}`);
    console.log('');
    total += a.removes;
  }
  console.log(`${args.apply ? 'Removed' : 'Would remove'} ${btc(total)} BTC across ${args.users.length} wallet(s).`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('reset-fake-balances.js')) {
  main()
    .catch(err => { console.error(`\nError: ${err.message}`); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
}
