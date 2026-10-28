/**
 * scripts/reset-fake-balances.js lowers forged wallets to what their settled
 * mining days support, never raises one, leaves deposit currencies alone,
 * records every reset, and skips a wallet that changed after it was read.
 */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'resettest' });
const db = mongoose.connection.db;
const { assess, reset } = await import('../scripts/reset-fake-balances.js');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const D = v => mongoose.Types.Decimal128.fromString(String(v));
const id = () => new mongoose.Types.ObjectId().toString();
const wallet = async u => db.collection('balances').findOne({ user: u });
const close = (a, b) => Math.abs(a - b) < 1e-12;

// Forged: 9 BTC in BTC, 9 USDT, nothing mined.
const forged = id();
await db.collection('balances').insertOne({ user: forged, BTC: D(9), BTC_DEPOSIT: D('0.0000000993699995'), USDT: D(9) });
// Inflated: real days plus one impossible day, and a withdrawal.
const inflated = id();
await db.collection('balances').insertOne({ user: inflated, BTC: D(0), BTC_DEPOSIT: D('0.0045'), USDT: D(0) });
await db.collection('balancehistories').insertMany([
  { user: inflated, date: new Date('2026-08-01'), balances: { BTC: D('0.000001') } },
  { user: inflated, date: new Date('2026-08-02'), balances: { BTC: D('0.000002') } },
  { user: inflated, date: new Date('2026-08-03'), balances: { BTC: D('0.004') } },
]);
await db.collection('withdrawals').insertOne({ userId: inflated, status: 'SENT', defaultAmountNumeric: D('0.000001') });
// Honest: wallet below what it mined -- must not be raised.
const honest = id();
await db.collection('balances').insertOne({ user: honest, BTC: D(0), BTC_DEPOSIT: D('0.000001') });
await db.collection('balancehistories').insertOne({ user: honest, date: new Date('2026-09-01'), balances: { BTC: D('0.000005') } });

let a = await assess(db, forged);
check('forged: nothing mined, everything removed', a.supported === 0 && a.after.BTC_DEPOSIT === 0 && close(a.removes, 9.0000000993699995), JSON.stringify(a));
check('forged: USDT reported, not changed', a.others.USDT === 9);
check('preview changes nothing', String((await wallet(forged)).BTC) === '9');
let r = await reset(db, a, 'test');
let w = await wallet(forged);
check('forged reset to 0', /^reset/.test(r) && Number(w.BTC.toString()) === 0 && Number(w.BTC_DEPOSIT.toString()) === 0, r);
check('USDT left as is', Number(w.USDT.toString()) === 9);
const rec = await db.collection('balanceadjustments').findOne({ user: forged });
check('reset recorded with old and new figures', rec?.applied === true && rec.before.BTC === '9' && rec.after.BTC_DEPOSIT === '0.0000000000');
check('second run: nothing to remove', (await reset(db, await assess(db, forged), 'test')) === 'nothing to remove');

a = await assess(db, inflated);
check('impossible day left out', a.implausible === 1 && close(a.settled, 0.000003), JSON.stringify(a));
check('withdrawal subtracted', close(a.supported, 0.000002) && close(a.after.BTC_DEPOSIT, 0.000002), JSON.stringify(a.after));
r = await reset(db, a, 'test');
check('inflated lowered to supported', close(Number((await wallet(inflated)).BTC_DEPOSIT.toString()), 0.000002), r);

a = await assess(db, honest);
check('honest wallet never raised', close(a.after.BTC_DEPOSIT, 0.000001) && a.removes <= 1e-15, JSON.stringify(a));

// Changed between preview and apply (settlement credited a day).
const racing = id();
await db.collection('balances').insertOne({ user: racing, BTC: D(1), BTC_DEPOSIT: D(0) });
a = await assess(db, racing);
await db.collection('balances').updateOne({ user: racing }, { $set: { BTC_DEPOSIT: D('0.00001') } });
r = await reset(db, a, 'test');
check('wallet changed after reading: skipped, untouched', /SKIPPED/.test(r) && String((await wallet(racing)).BTC) === '1', r);
check('skipped reset leaves no record', (await db.collection('balanceadjustments').countDocuments({ user: racing })) === 0);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await mongoose.disconnect(); await mongod.stop(); process.exit(fail ? 1 : 0);
