#!/usr/bin/env node
/**
 * How many users can a broadcast reach, and who is missing? Read-only; prints
 * counts only. Run on the server from the backend folder:
 *
 *   node scripts/notification-reach.js
 *
 * The question it answers: is the gap between accounts and registered devices
 * inactive users (normal -- the app registers a device each time Home opens,
 * and tokens of uninstalled apps are removed), or active users whose device
 * never registered (a bug)?
 */
import '../config/loadEnv.js';
import mongoose from 'mongoose';

const DAY = 24 * 60 * 60 * 1000;

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set (.env next to server.js).');
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const now = Date.now();

  const [users, tokenUserIds, optedOut] = await Promise.all([
    db.collection('users').countDocuments(),
    db.collection('firebasenotifications').distinct('user_id'),
    db.collection('notificationpreferences').countDocuments({ push: false }),
  ]);
  const withToken = new Set(tokenUserIds.map(String));

  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '-');
  console.log('\nAccounts and devices');
  console.log(`  accounts:                         ${users}`);
  console.log(`  accounts with a registered device: ${withToken.size}  (${pct(withToken.size, users)})`);
  console.log(`  accounts that turned push off:     ${optedOut}`);

  console.log('\nActive users (mining record updated within the window)');
  console.log('  window   active   with device   WITHOUT device');
  for (const days of [1, 7, 30, 90]) {
    const since = new Date(now - days * DAY);
    const active = await db.collection('userminings')
      .distinct('user', { updatedAt: { $gte: since } });
    const ids = active.map(String);
    const reachable = ids.filter(id => withToken.has(id)).length;
    const missing = ids.length - reachable;
    console.log(`  ${String(days).padStart(3)}d   ${String(ids.length).padStart(7)}   ${String(reachable).padStart(11)}   ${String(missing).padStart(8)}  (${pct(missing, ids.length)} of active)`);
  }

  console.log('\nHow to read it: the gap between accounts and devices is normal if most');
  console.log('accounts are inactive. If many ACTIVE users are "without device", devices');
  console.log('are failing to register, and that is worth fixing in the app.\n');
}

main()
  .catch(err => { console.error(`\nError: ${err.message}`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
