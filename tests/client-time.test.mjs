/**
 * Client dates are believed only when possible: "today" in some real
 * timezone (UTC-12..UTC+14). Replays the 18 Oct 2026 scanner (dates in
 * 2027-2037, offset -525600) and checks honest users in every timezone, and
 * users whose phone clock is wrong, are unaffected.
 *
 * Run: node tests/client-time.test.mjs
 */
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  plausibleDayRange, isPlausibleDay, isPlausibleOffset, isValidTimeZone, trustedDay, isFutureDay, isPlausibleTimestamp,
} from '../helpers/clientTime.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const H = 3600 * 1000;

console.log('\n--- every real timezone is accepted ---');
// Fixed instants, including both sides of midnight UTC.
for (const iso of ['2026-10-21T00:30:00Z', '2026-10-21T11:59:00Z', '2026-10-21T23:30:00Z']) {
  const now = Date.parse(iso);
  const days = [];
  for (let off = -840; off <= 720; off += 15) days.push(new Date(now - off * 60000).toISOString().slice(0, 10));
  check(`at ${iso}: today in all 106 offsets from UTC-12 to UTC+14 is plausible`, days.every(d => isPlausibleDay(d, now)), JSON.stringify(plausibleDayRange(now)));
}
const now = Date.parse('2026-10-21T12:00:00Z');
for (const tz of ['Asia/Kolkata', 'Asia/Tehran', 'Asia/Samarkand', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Managua', 'Asia/Calcutta', 'UTC']) {
  const day = new Date(now).toLocaleDateString('en-CA', { timeZone: tz });
  check(`${tz}: its local day is plausible, timezone valid`, isPlausibleDay(day, now) && isValidTimeZone(tz));
}

console.log('\n--- the scanner\'s values are refused ---');
for (const d of ['2027-10-18', '2034-01-01', '2035-04-10', '2036-07-18', '2037-01-02', '2026-10-23', '2026-10-19']) {
  check(`day ${d} refused at ${new Date(now).toISOString().slice(0, 10)}`, !isPlausibleDay(d, now));
}
check('offset -525600 (one year) refused', !isPlausibleOffset(-525600));
check('offsets -840 and +720 accepted, -841 and +721 refused', isPlausibleOffset(-840) && isPlausibleOffset(720) && !isPlausibleOffset(-841) && !isPlausibleOffset(721));
check('null / "" / NaN offsets refused', !isPlausibleOffset(null) && !isPlausibleOffset('') && !isPlausibleOffset(NaN));
check('junk timezone refused', !isValidTimeZone('Mars/Olympus') && !isValidTimeZone('') && !isValidTimeZone(null));
check('start time 1 hour ahead refused; 1 minute ahead allowed (clock skew)', !isPlausibleTimestamp(now + H, now) && isPlausibleTimestamp(now + 60000, now));
check('2037 counter date counts as frozen in the future', isFutureDay('2037-10-10', now) && !isFutureDay('2026-10-21', now));

console.log('\n--- choosing "today" ---');
let t = trustedDay({ local_time: '21/10/2026, 05:30:00 PM', offset: -330 }, now);
check('honest app: its own local day is used', t.day === '2026-10-21' && t.source === 'local_time' && !t.ignored.length);
t = trustedDay({ local_time: '18/07/2036, 10:00:00 AM', offset: -330 }, now);
check('future local_time ignored, offset used instead', t.day === '2026-10-21' && t.source === 'offset' && t.ignored.length === 1);
t = trustedDay({ local_time: '02/01/2037, 10:00:00 AM', offset: -525600, storedOffset: -330 }, now);
check('future date AND fake offset: the stored offset decides', t.day === '2026-10-21' && t.source === 'stored offset' && t.ignored.length === 2, JSON.stringify(t));
t = trustedDay({ local_time: '02/01/2037, 10:00:00 AM', offset: -525600 }, now);
check('nothing usable: server UTC day', t.day === '2026-10-21' && t.source === 'server UTC');

console.log('\n--- through the real routes ---');
const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'ctime' });
const Mining = (await import('../models/UserMiningDetails.js')).default;
const DailyFreeMiner = (await import('../models/DailyMiner.js')).default;
const { default: miningRouter } = await import('../routes/api_routes/user-mining-handles.js');
const { default: dailyRouter } = await import('../routes/api_routes/daily-miner-handles.js');
const app = express(); app.use(express.json());
app.use('/api/user_mining', miningRouter); app.use('/api/claim_daily_miner', dailyRouter);
const uid = () => new mongoose.Types.ObjectId().toString();
const rec = u => Mining.findOne({ user: u }).lean();
const todayUtc = () => new Date().toISOString().slice(0, 10);
const ist = new Date(Date.now() + 330 * 60000);
const IST_NOW = `${String(ist.getUTCDate()).padStart(2, '0')}/${String(ist.getUTCMonth() + 1).padStart(2, '0')}/${ist.getUTCFullYear()}, 10:00:00 AM`;
const IST_DAY = ist.toISOString().slice(0, 10);

let u = uid();
await request(app).post('/api/user_mining').send({ user_id: u, hashpower: 0, mining_isactive: true, start_time: Date.now(), offset: -330, timezone: 'Asia/Kolkata', local_time: IST_NOW });
await request(app).post('/api/user_mining').send({ user_id: u, hashpower: 25, mining_isactive: true, offset: -330, local_time: IST_NOW });
let r = await rec(u);
check('honest user (India): streak and start reward on their real day', r.streakLastDate === IST_DAY && r.streakDays === 1 && r.claimedHashpower === 25, `${r.streakLastDate} ${r.streakDays} ${r.claimedHashpower}`);

u = uid();
await request(app).post('/api/user_mining').send({ user_id: u, hashpower: 0, mining_isactive: true, start_time: Date.now(), offset: -330, timezone: 'Asia/Kolkata', local_time: IST_NOW });
for (const fake of ['18/07/2036, 10:00:00 AM', '19/07/2036, 10:00:00 AM', '20/07/2036, 10:00:00 AM']) {
  await request(app).post('/api/user_mining').send({ user_id: u, hashpower: 25, mining_isactive: true, offset: -330, local_time: fake });
}
r = await rec(u);
check('scanner trick: three "future days" give no streak and one start reward', r.streakDays === 1 && r.streakLastDate === IST_DAY && r.claimedHashpower === 25 && r.startRewardDay === IST_DAY, `${r.streakDays} ${r.streakLastDate} ${r.claimedHashpower} ${r.startRewardDay}`);

u = uid();
await request(app).post('/api/user_mining').send({ user_id: u, hashpower: 0, mining_isactive: true, start_time: Date.now() + 365 * 24 * H, offset: -525600, timezone: 'Mars/Olympus', local_start_time: '02/01/2037, 10:00:00 AM' });
r = await rec(u);
check('fake offset and timezone are not stored', r.offset !== -525600 && r.timezone !== 'Mars/Olympus', `${r.offset} ${r.timezone}`);
check('future start time replaced with now', r.start_time <= Date.now() && r.start_time > Date.now() - 60000, new Date(r.start_time).toISOString());
check('future local_start_time not stored (server derives it)', !String(r.local_start_time).includes('2037'), r.local_start_time);

u = uid();
await Mining.create({ user: u, mining_isactive: true, start_time: Date.now(), offset: -330, timezone: 'Asia/Kolkata', hashpower: 10, rewarded_ads_watched: 0, random_ads_watched: 0 });
let res = await request(app).post('/api/claim_daily_miner').send({ userId: u, local_time: '02/01/2037, 10:00:00 AM' });
let claim = await DailyFreeMiner.findOne({ userId: u }).lean();
r = await rec(u);
check('daily claim with a wrong phone clock still works, on the real day', res.body.success === true && claim && Math.abs(new Date(claim.claimedAt).getTime() - Date.now()) < 26 * H && r.streakLastDate !== '2037-01-02', `${JSON.stringify(res.body)} ${claim?.claimedAt} ${r.streakLastDate}`);

u = uid();
await Mining.create({ user: u, mining_isactive: true, start_time: Date.now(), offset: -330, timezone: 'Asia/Kolkata', hashpower: 10, rewarded_ads_watched: 0, random_ads_watched: 0 });
res = await request(app).post('/api/claim_daily_miner').send({ userId: u, local_time: 'garbage' });
check('malformed local_time no longer crashes the daily claim (was a 500)', res.status === 200 && res.body.success === true, `${res.status} ${JSON.stringify(res.body)}`);

await mongoose.disconnect();
await mongod.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
