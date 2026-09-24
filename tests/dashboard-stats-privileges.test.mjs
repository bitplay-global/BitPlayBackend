/**
 * Super Privilege purchases (AdMultiplierPrivilege) showed correctly in their
 * own "Super Miner" list but never counted toward the dashboard's in-app
 * purchases total, because every revenue aggregate in dashboardStats.js read
 * only from the Purchase collection. Verifies both collections are combined.
 */
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
await mongoose.connect(mongod.getUri(), { dbName: 'dashstatstest' });
const Purchase = (await import('../models/Purchase.js')).default;
const AdMultiplierPrivilege = (await import('../models/AdMultiplierPrivilege.js')).default;
const { getDashboardStats, getDashboardStatsFiltered } = await import('../helpers/dashboardStats.js');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const uid = () => new mongoose.Types.ObjectId().toString();

const now = new Date();

await Purchase.create({
  user: uid(), plan_id: new mongoose.Types.ObjectId(), product_identifier: 'plan.cheap',
  price_paid: 10, currency: 'USD', purchase_date: now, status: 'completed',
  existing_hashpower: 0, updated_hashpower: 10,
});
await AdMultiplierPrivilege.create({
  user: uid(), tier: '5000pct', multiplier: 50, product_identifier: 'bitplay.super_privilege_5000pct',
  price_paid: 25, currency: 'USD', purchase_date: now,
  expires_at: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000), status: 'completed',
});
// A pending/refunded privilege must not count.
await AdMultiplierPrivilege.create({
  user: uid(), tier: '10000pct', multiplier: 100, product_identifier: 'bitplay.super_privilege_10000pct',
  price_paid: 999, currency: 'USD', purchase_date: now,
  expires_at: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000), status: 'refunded',
});

console.log('\n--- all-time dashboard stats ---');
const stats = await getDashboardStats();
check('purchaseTotal includes the Super Privilege purchase (10 + 25 = 35)', stats.purchaseTotal === 35, `got ${stats.purchaseTotal}`);
check('totalRevenue reflects it too', stats.totalRevenue >= 35, `got ${stats.totalRevenue}`);

console.log('\n--- date-range-filtered stats ---');
const filtered = await getDashboardStatsFiltered({ allTime: true });
check('filtered purchaseTotal also includes it', filtered.purchaseTotal === 35, `got ${filtered.purchaseTotal}`);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await mongoose.disconnect(); await mongod.stop(); process.exit(fail ? 1 : 0);
