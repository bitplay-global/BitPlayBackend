/**
 * Game streak and weekly leaderboard (helpers/gameEngagement.js).
 * Verifies: a streak counts days with a granted game reward; days 3, 5 and 7
 * of the cycle pay 10/20/30 GH/s for 24h, once per day; the cycle restarts
 * after day 7; a gap resets it; only labelled game wins count through the
 * mining route; the leaderboard ranks by GH/s this week with short names and
 * no emails; the user's own rank is right.
 * Run: node tests/game-engagement.test.mjs
 */
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
await mongoose.connect(mongod.getUri(), { dbName: 'gametest' });
const Mining = (await import('../models/UserMiningDetails.js')).default;
const Bonus = (await import('../models/BonusGrant.js')).default;
const Log = (await import('../models/GameRewardLog.js')).default;
await Bonus.syncIndexes(); await Log.syncIndexes();
const E = await import('../helpers/gameEngagement.js');

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const users = mongoose.connection.collection('users');
const hp = async u => (await Mining.findOne({ user: u }).lean()).purchasedHashpower;

console.log('\n--- pure rules ---');
check('streak counts back from today', E.streakFromDays(['2026-10-28', '2026-10-29', '2026-10-30'], '2026-10-30').days === 3);
check('today not played yet: counts to yesterday', E.streakFromDays(['2026-10-28', '2026-10-29'], '2026-10-30').days === 2);
check('a gap breaks it', E.streakFromDays(['2026-10-26', '2026-10-28', '2026-10-29'], '2026-10-29').days === 2);
check('cycle restarts after 7', E.cycleDay(7) === 7 && E.cycleDay(8) === 1 && E.cycleDay(10) === 3);
check('week starts Monday UTC', E.weekStart(new Date('2026-10-30T12:00:00Z')).toISOString() === '2026-10-26T00:00:00.000Z');
check('name shortened', E.displayName({ name: 'Sunil Bhandari' }) === 'Sunil B.');
check('email-like name never shown', !E.displayName({ _id: 'abcd1234', name: 'x@y.com' }).includes('@'));

console.log('\n--- streak bonuses ---');
const u = new mongoose.Types.ObjectId(); const U = String(u);
await users.insertOne({ _id: u, name: 'Asha Kumar', email: 'asha@x.com', isActive: true });
await Mining.collection.insertOne({ user: U, hashpower: 0, claimedHashpower: 0, purchasedHashpower: 0 });
const day = n => new Date(Date.UTC(2026, 9, 24 + n)).toISOString().slice(0, 10); // day(1) = 2026-10-25
const results = [];
for (let d = 1; d <= 8; d++) {
  results.push(await E.recordGameReward({ userId: U, gh: 5, day: day(d), now: new Date() }));
  // a second win the same day never pays the streak again
  await E.recordGameReward({ userId: U, gh: 3, day: day(d), now: new Date() });
}
const paid = results.map(r => r?.bonusGh || 0);
check('pays on days 3, 5, 7 only', JSON.stringify(paid) === JSON.stringify([0, 0, 10, 0, 20, 0, 30, 0]), JSON.stringify(paid));
check('bonuses added as mining power', (await hp(U)) === 60, String(await hp(U)));
check('one bonus record per paying day', (await Bonus.countDocuments({ user: u })) === 3);
const s = await E.gameStreak(U, day(8));
check('streak state on day 8', s.streakDays === 8 && s.cycleDay === 1 && s.nextBonusDay === 3 && s.daysToNextBonus === 2 && s.playedToday, JSON.stringify(s));
check('losses/zero never logged', (await E.recordGameReward({ userId: U, gh: 0, day: day(9) })) === null && !(await Log.exists({ user: U, day: day(9) })));

console.log('\n--- leaderboard ---');
await Log.deleteMany({});
const now = new Date('2026-10-30T12:00:00Z');
const mk = async (name, gh, at = now) => {
  const id = new mongoose.Types.ObjectId();
  await users.insertOne({ _id: id, name, email: `${name.split(' ')[0]}@mail.com` });
  await Log.create({ user: String(id), gh, day: '2026-10-30', at });
  return String(id);
};
const a = await mk('Ravi Patel', 50);
const b = await mk('Mei Lin', 80);
await mk('Old Week', 500, new Date('2026-10-20T00:00:00Z'));
const c = await mk('Zed', 20);
const board = await E.weeklyLeaderboard({ now });
check('ranked by GH/s this week, last week excluded', board.rows.map(r => r.name).join('|') === 'Mei L.|Ravi P.|Zed', board.rows.map(r => r.name).join('|'));
check('no emails in the board', !JSON.stringify(board).includes('@'));
const me = await E.myWeek(c, now);
check('own rank and GH/s', me.rank === 3 && me.gh === 20, JSON.stringify(me));
check('no wins: no rank', (await E.myWeek(String(new mongoose.Types.ObjectId()), now)).rank === null);

console.log('\n--- most played ---');
await Log.deleteMany({});
const add = (game, n, at = now) => Log.insertMany(Array.from({ length: n }, (_, i) => ({ user: `u${i % 3}`, gh: 5, day: '2026-10-30', game, at })));
await add('Lucky Dice', 5); await add('BTC Trading', 9); await add('Spin & Win', 2);
await add('Slot Machine', 50, new Date('2026-08-01T00:00:00Z')); // older than 30 days
await Log.create({ user: 'x', gh: 5, day: '2026-10-30', at: now }); // no game name (old app)
const pop = await E.popularGames({ limit: 3, now });
check('most played, last 30 days, by wins', pop.map(p => p.gameName).join('|') === 'BTC Trading|Lucky Dice|Spin & Win' && pop[0].totalSessions === 9, JSON.stringify(pop));
check('unlabelled rows ignored, players counted', !pop.some(p => !p.gameName) && pop[0].players === 3);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await mongoose.disconnect(); await mongod.stop(); process.exit(fail ? 1 : 0);
