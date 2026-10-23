/**
 * Which app version are users on, and how engaged is each version?
 *
 * Reads users.app (written by middleware/appVersionTracker.js on every app
 * request, at most every 10 minutes per user) and mining/withdrawal activity.
 *
 *   node scripts/app-version-report.js            # active in the last 7 days
 *   node scripts/app-version-report.js --days 30
 */
import '../config/loadEnv.js';
import mongoose from 'mongoose';

const i = process.argv.indexOf('--days');
const DAYS = i > 0 ? Number(process.argv[i + 1]) || 7 : 7;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const since = new Date(Date.now() - DAYS * 86400000);
  const rows = await db.collection('users').aggregate([
    { $match: { 'app.lastSeenAt': { $gte: since } } },
    { $group: { _id: { platform: '$app.platform', version: '$app.version', build: '$app.build' }, users: { $sum: 1 },
      last24h: { $sum: { $cond: [{ $gte: ['$app.lastSeenAt', new Date(Date.now() - 86400000)] }, 1, 0] } } } },
    { $sort: { users: -1 } },
  ]).toArray();
  const total = rows.reduce((s, r) => s + r.users, 0);
  const tracked = await db.collection('users').countDocuments({ 'app.lastSeenAt': { $exists: true } });
  console.log(`Users seen in the last ${DAYS} days, by app version (tracking since ${(await db.collection('users').find({ 'app.lastSeenAt': { $exists: true } }).sort({ 'app.lastSeenAt': 1 }).limit(1).next())?.app?.lastSeenAt?.toISOString().slice(0, 16) || 'n/a'} UTC; ${tracked} users tracked so far)\n`);
  console.log('platform  version   build    users   share   active 24h');
  for (const r of rows) {
    const { platform, version, build } = r._id;
    console.log(`${String(platform || '?').padEnd(9)} ${String(version || '?').padEnd(9)} ${String(build || '-').padEnd(8)} ${String(r.users).padStart(5)}  ${(100 * r.users / total).toFixed(1).padStart(5)}%  ${String(r.last24h).padStart(6)}`);
  }
  console.log(`${''.padEnd(28)} ${String(total).padStart(5)}`);
  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
