/**
 * Engagement pushes (helpers/engagementReminders.js). Verifies: the streak
 * reminder goes only to players at local 20:00 with a streak running and no
 * game today, once per day, with the bonus line when today would pay; the
 * leaderboard nudge goes to the top players with rank and gap, once per day.
 * Run: node tests/engagement-reminders.test.mjs
 */
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'remindertest' });
const Mining = (await import('../models/UserMiningDetails.js')).default;
const Log = (await import('../models/GameRewardLog.js')).default;
const R = await import('../helpers/engagementReminders.js');
await R.ReminderLog.syncIndexes();

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const sent = [];
const send = async (users, n) => { sent.push({ users, n }); return { sent: users.length }; };

// 14:30 UTC = 20:00 in India (UTC+5:30).
const now = new Date('2026-10-30T14:30:00Z');
const day = d => `2026-10-${String(d).padStart(2, '0')}`;
const mk = async (user, tz, days) => {
  await Mining.collection.insertOne({ user, timezone: tz, offset: -330, hashpower: 0 });
  for (const d of days) await Log.create({ user, gh: 5, day: d, game: 'Lucky Dice' });
};
await mk('atRisk', 'Asia/Kolkata', [day(28), day(29)]);       // 2-day streak, not today -> remind, today = day 3 pays +10
await mk('playedToday', 'Asia/Kolkata', [day(29), day(30)]);  // already played
await mk('wrongHour', 'America/New_York', [day(29)]);         // 10:30 there
await mk('noStreak', 'Asia/Kolkata', [day(27)]);              // broken (gap)

console.log('\n--- local clock ---');
check('India 14:30 UTC is 20h', R.localClock(now, 'Asia/Kolkata').hour === 20);
check('offset fallback', R.localClock(now, null, -330).hour === 20 && R.localClock(now, 'Not/AZone', -330).hour === 20);

console.log('\n--- streak reminder ---');
let r = await R.sendStreakReminders({ now, send });
const users = sent.flatMap(s => s.users);
check('only the player at risk', users.join() === 'atRisk', users.join());
check('says the streak and today\'s bonus', /2-day game streak/.test(sent[0]?.n.title) && /\+10 GH\/s/.test(sent[0]?.n.body), JSON.stringify(sent[0]?.n));
sent.length = 0;
r = await R.sendStreakReminders({ now: new Date(now.getTime() + 20 * 60000), send });
check('not twice the same day', sent.length === 0, JSON.stringify(sent));

console.log('\n--- leaderboard ---');
await Log.deleteMany({});
const ids = [];
for (const [name, gh] of [['A', 90], ['B', 60], ['C', 40]]) {
  const id = new mongoose.Types.ObjectId();
  ids.push(String(id));
  await mongoose.connection.collection('users').insertOne({ _id: id, name });
  await Log.create({ user: String(id), gh, day: day(30), game: 'Slot Machine', at: now });
}
sent.length = 0;
r = await R.sendLeaderboardReminders({ now, send });
check('top players nudged', r.players === 3 && sent.length === 3);
check('#1 told they lead', /#1/.test(sent[0].n.title));
check('#3 told the gap to #2', /#3/.test(sent[2].n.title) && /20 GH\/s behind #2/.test(sent[2].n.body), sent[2].n.body);
sent.length = 0;
await R.sendLeaderboardReminders({ now, send });
check('once per day', sent.length === 0);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await mongoose.disconnect(); await mongod.stop(); process.exit(fail ? 1 : 0);
