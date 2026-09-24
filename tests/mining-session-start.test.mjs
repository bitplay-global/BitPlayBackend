/**
 * A mining session activated without local_start_time (the app still holding
 * the previous day's start after midnight) was skipped by the hourly
 * settlement forever: no BTC credited, ad cap and daily claim stuck -- a real
 * user was stuck from 13 to 21 Sep 2026. Verifies the activation now always
 * leaves a usable start, normal activations are stored exactly as before, and
 * the settlement can place already-stuck sessions on their day.
 */
import fs from 'fs';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  resolveSessionStartDateStr, formatLocalStartTime, getLocalDateStrAt, getSessionStartDateStrFromLocalStart,
} from '../helpers/miningDaySettlement.js';

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'sessiontest' });
const Mining = (await import('../models/UserMiningDetails.js')).default;
const { default: router } = await import('../routes/api_routes/user-mining-handles.js');
const app = express(); app.use(express.json()); app.use('/api/user_mining', router);
const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const uid = () => new mongoose.Types.ObjectId().toString();
const TZ = 'Asia/Kolkata', OFF = -330;
const post = body => request(base).post('/api/user_mining').send({ offset: OFF, timezone: TZ, random_ads_watched: 0, ...body });
const rec = u => Mining.findOne({ user: u }).lean();
const todayIst = () => getLocalDateStrAt(Date.now(), TZ, OFF);

console.log('\n--- helpers ---');
const stuck = { local_start_time: null, start_time: 1789307714440, timezone: TZ, offset: OFF };
check('stuck session placed on its real day (13 Sep IST)', resolveSessionStartDateStr(stuck) === '2026-09-13');
check('offset alone gives the same day', resolveSessionStartDateStr({ ...stuck, timezone: null }) === '2026-09-13');
check('local_start_time still wins when present', resolveSessionStartDateStr({ ...stuck, local_start_time: '12/09/2026, 11:00:00 PM' }) === '2026-09-12');
check('no start at all: null (skipped, as before)', resolveSessionStartDateStr({ local_start_time: null, start_time: 0 }) === null);
check('server-made local time uses the app format', formatLocalStartTime(1789307714440, TZ, OFF) === '13/09/2026, 07:25:14 PM', formatLocalStartTime(1789307714440, TZ, OFF));
check('midnight and noon are 12 AM / 12 PM', formatLocalStartTime(Date.UTC(2026, 8, 13, 18, 30, 0), TZ, OFF) === '14/09/2026, 12:00:00 AM' && formatLocalStartTime(Date.UTC(2026, 8, 14, 6, 30, 0), TZ, OFF) === '14/09/2026, 12:00:00 PM');
check('what the server writes, the settlement reads back', getSessionStartDateStrFromLocalStart(formatLocalStartTime(1789307714440, TZ, OFF)) === '2026-09-13');

console.log('\n--- normal activation: stored exactly as the app sent it ---');
let u = uid(); let now = Date.now();
await post({ user_id: u, hashpower: 0, mining_isactive: true, start_time: now, local_start_time: '21/09/2026, 10:00:00 AM', rewarded_ads_watched: 0 });
let r = await rec(u);
check('start_time kept', r.start_time === now, `${r.start_time} vs ${now}`);
check('local_start_time kept', r.local_start_time === '21/09/2026, 10:00:00 AM');

console.log('\n--- the bug: new session with yesterday\'s start and no local_start_time ---');
u = uid();
await Mining.create({ user: u, mining_isactive: false, start_time: 0, local_start_time: null, hashpower: 0, offset: OFF, timezone: TZ, rewarded_ads_watched: 0, random_ads_watched: 0 });
const yesterday = Date.now() - 20 * 3600 * 1000 - 5 * 3600 * 1000;
now = Date.now();
await post({ user_id: u, hashpower: 0, mining_isactive: true, start_time: yesterday, local_start_time: null, rewarded_ads_watched: 0 });
r = await rec(u);
check('stale start replaced with now', r.start_time >= now && r.start_time <= Date.now(), `${new Date(r.start_time).toISOString()}`);
check('local_start_time filled in', typeof r.local_start_time === 'string' && getSessionStartDateStrFromLocalStart(r.local_start_time) === todayIst(), r.local_start_time);
check('session is active', r.mining_isactive === true);

console.log('\n--- new session with no start at all ---');
u = uid(); now = Date.now();
await post({ user_id: u, hashpower: 0, mining_isactive: true, start_time: null, local_start_time: null, rewarded_ads_watched: 0 });
r = await rec(u);
check('start_time set to now', r.start_time >= now);
check('local_start_time set', getSessionStartDateStrFromLocalStart(r.local_start_time) === todayIst(), r.local_start_time);

console.log('\n--- same-day restart keeps the earlier start (unchanged behaviour) ---');
u = uid();
const earlierToday = Date.now() - 1000;
await Mining.create({ user: u, mining_isactive: false, start_time: earlierToday, local_start_time: null, hashpower: 10, offset: OFF, timezone: TZ, rewarded_ads_watched: 0, random_ads_watched: 0 });
await post({ user_id: u, hashpower: 0, mining_isactive: true, start_time: earlierToday, local_start_time: null, rewarded_ads_watched: 0 });
r = await rec(u);
check('start kept as earlier today', r.start_time === earlierToday, `${r.start_time} vs ${earlierToday}`);
check('local_start_time derived from it', r.local_start_time === formatLocalStartTime(earlierToday, TZ, OFF), r.local_start_time);

console.log('\n--- ad claim during an active session changes no session fields ---');
u = uid(); now = Date.now();
await post({ user_id: u, hashpower: 0, mining_isactive: true, start_time: now, local_start_time: '21/09/2026, 10:00:00 AM', rewarded_ads_watched: 0 });
await post({ user_id: u, hashpower: 5.5, mining_isactive: true, start_time: now, local_start_time: null, rewarded_ads_watched: 1 });
r = await rec(u);
check('start and local start untouched', r.start_time === now && r.local_start_time === '21/09/2026, 10:00:00 AM');
check('ad reward still added', r.claimedHashpower === 5.5, `claimed ${r.claimedHashpower}`);

console.log('\n--- hourly settlement now includes sessions without local_start_time ---');
const cron = fs.readFileSync(new URL('../cronJobs.js', import.meta.url), 'utf8');
const q = cron.match(/UserMiningDetail\.find\(\{\s*mining_isactive: true,[\s\S]*?\}\);/)?.[0] || '';
check('query no longer requires local_start_time', q && !/local_start_time/.test(q), q);
check('settlement uses resolveSessionStartDateStr', /resolveSessionStartDateStr\(miningDetail\)/.test(cron));
const stuckId = uid();
await Mining.create({ user: stuckId, mining_isactive: true, start_time: 1789307714440, local_start_time: null, hashpower: 805, offset: OFF, timezone: TZ, rewarded_ads_watched: 60, random_ads_watched: 0 });
const picked = await Mining.find({ mining_isactive: true, start_time: { $gt: 0 } }).lean();
const s = picked.find(d => d.user === stuckId);
check('the stuck session is picked up and placed on 13 Sep, before today', !!s && resolveSessionStartDateStr(s) === '2026-09-13' && resolveSessionStartDateStr(s) < todayIst());

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
server.close(); await mongoose.disconnect(); await mongod.stop(); process.exit(fail ? 1 : 0);
