#!/usr/bin/env node
/**
 * Read-only report of the game economy, to judge free retries, lucky rounds,
 * streaks and the leaderboard after a release (compare with AdMob revenue).
 * Changes nothing.
 *
 *   node scripts/game-economy-report.js            (last 14 days)
 *   node scripts/game-economy-report.js --days 30
 *
 * Per day: game wins claimed, GH/s paid for them, players, streak and
 * referral bonuses (BonusGrant), and the top games over the period.
 * Each claimed win is one rewarded video watched, so "wins" is also the
 * number of claim videos from games.
 */
import '../config/loadEnv.js';
import mongoose from 'mongoose';

const arg = process.argv.indexOf('--days');
const days = Math.min(Math.max(parseInt(arg > -1 ? process.argv[arg + 1] : '14', 10) || 14, 1), 90);

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set (.env next to server.js).');
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const since = new Date(Date.now() - days * 864e5);
  const dayOf = { $dateToString: { format: '%Y-%m-%d', date: '$at' } };

  const wins = await db.collection('gamerewardlogs').aggregate([
    { $match: { at: { $gte: since } } },
    { $group: { _id: dayOf, wins: { $sum: 1 }, gh: { $sum: '$gh' }, players: { $addToSet: '$user' } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  const bonuses = await db.collection('bonusgrants').aggregate([
    { $match: { starts_at: { $gte: since }, key: { $regex: '^(gamestreak|referral):' } } },
    { $group: {
      _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$starts_at' } }, kind: { $arrayElemAt: [{ $split: ['$key', ':'] }, 0] } },
      n: { $sum: 1 }, gh: { $sum: '$hashpower' } } },
  ]).toArray();
  const bonusBy = new Map(bonuses.map(b => [`${b._id.day}|${b._id.kind}`, b]));

  console.log(`\nGame economy, last ${days} day(s) (UTC days)\n`);
  console.log('day         wins   GH/s paid  players  streak bonus (n / GH)  referral bonus (n / GH)');
  for (const w of wins) {
    const s = bonusBy.get(`${w._id}|gamestreak`);
    const r = bonusBy.get(`${w._id}|referral`);
    console.log(`${w._id}  ${String(w.wins).padStart(5)}  ${w.gh.toFixed(1).padStart(9)}  ${String(w.players.length).padStart(7)}  ${String(s ? `${s.n} / ${s.gh}` : '-').padStart(21)}  ${String(r ? `${r.n} / ${Math.round(r.gh)}` : '-').padStart(23)}`);
  }
  if (!wins.length) console.log('(no game wins recorded yet -- needs the app build that labels game wins)');

  const top = await db.collection('gamerewardlogs').aggregate([
    { $match: { at: { $gte: since }, game: { $nin: ['', null] } } },
    { $group: { _id: '$game', wins: { $sum: 1 }, players: { $addToSet: '$user' } } },
    { $sort: { wins: -1 } }, { $limit: 10 },
  ]).toArray();
  console.log('\nTop games by claimed wins:');
  for (const t of top) console.log(`  ${t._id.padEnd(22)} ${String(t.wins).padStart(6)} wins  ${String(t.players.length).padStart(5)} players`);
  console.log('');
}

main()
  .catch(err => { console.error(`\nError: ${err.message}`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
