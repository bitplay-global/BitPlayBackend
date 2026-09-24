#!/usr/bin/env node
/**
 * Read-only support diagnostic for one user's mining and streak. Changes
 * nothing. Run on the server as root (it reads the nginx logs):
 *
 *   node scripts/diagnose-user.js --email someone@example.com --since 2026-09-10
 *   node scripts/diagnose-user.js --user <userId> --since 2026-09-10
 *
 * Prints the account's status, mining record, streak, recent mining sessions
 * and daily-reward claims, and -- from the nginx access logs -- every request
 * the user's app made and what the server answered, grouped by day. Failed
 * answers (4xx/5xx) are listed individually: they are usually the cause.
 *
 * No passwords, OTPs, tokens or wallet keys are read or printed.
 */
import '../config/loadEnv.js';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import mongoose from 'mongoose';

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function parseArgs(argv) {
  const a = { nginxDir: '/var/log/nginx' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--email') { a.email = v; i++; }
    else if (k === '--user') { a.user = v; i++; }
    else if (k === '--since') { a.since = v; i++; }
    else if (k === '--nginx-dir') { a.nginxDir = v; i++; }
    else throw new Error(`Unknown option: ${k}`);
  }
  if (!a.email && !a.user) throw new Error('Give --email <address> or --user <userId>.');
  a.since = new Date(a.since || Date.now() - 14 * 864e5);
  if (Number.isNaN(a.since.getTime())) throw new Error('--since must be a date, e.g. 2026-09-10');
  return a;
}

const iso = d => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '-');
const show = (label, value) => console.log(`  ${label.padEnd(30)} ${value === undefined ? '-' : typeof value === 'object' && value !== null && !(value instanceof Date) ? JSON.stringify(value) : value instanceof Date ? iso(value) : value}`);

function readNginx(dir, userId, since) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.startsWith('access.log')).map(f => path.join(dir, f)); } catch { return null; }
  const re = /^(\S+) .*?\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\] "(\w+) ([^" ]+)[^"]*" (\d{3}) \S+ "[^"]*" "([^"]*)"/;
  const parsed = [];
  for (const f of files) {
    let text;
    try { text = f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(f)).toString('utf8') : fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      // Cheap pre-filter: only this user's requests and anonymous-URL API POSTs.
      const mine = line.includes(userId);
      if (!mine && !line.includes('"POST /api/')) continue;
      const m = line.match(re);
      if (!m) continue;
      const [, ip, dd, mon, yyyy, hh, mi, ss, tz, method, url, status, ua] = m;
      const off = (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
      const at = new Date(Date.UTC(+yyyy, MONTHS[mon], +dd, +hh, +mi, +ss) - off * 60000);
      if (at < since) continue;
      parsed.push({ ip, at, method, url, status: Number(status), ua: ua.slice(0, 40), mine });
    }
  }
  // POST bodies are not logged, so a request carrying the id only in its body
  // (mining activation, session start) is invisible by id. Include /api POSTs
  // from the IP addresses this user's own requests came from, marked "(ip)";
  // skip any that name a different user id in the URL.
  const ips = new Set(parsed.filter(h => h.mine).map(h => h.ip));
  const hits = parsed
    .filter(h => h.mine || (ips.has(h.ip) && h.method === 'POST' && h.url.startsWith('/api/') && !/[0-9a-f]{24}/i.test(h.url)))
    .map(h => ({ at: h.at, method: h.method, path: h.url.split('?')[0].replace(userId, ':id') + (h.mine ? '' : ' (ip)'), status: h.status, ua: h.ua }));
  return hits.sort((a, b) => a.at - b.at);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set (.env next to server.js).');
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const safe = { _id: 1, email: 1, name: 1, isActive: 1, createdAt: 1, updatedAt: 1, lastLogin: 1, TwoFactorAuth: 1, isVerified: 1, provider: 1, authProvider: 1, referredBy: 1 };
  const query = args.user ? { _id: new mongoose.Types.ObjectId(args.user) } : { email: new RegExp(`^${args.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') };
  const users = await db.collection('users').find(query, { projection: safe }).toArray();
  if (!users.length) throw new Error('No such user.');
  if (users.length > 1) console.log(`  ! ${users.length} accounts match; showing the first. IDs: ${users.map(u => u._id).join(', ')}`);
  const user = users[0];
  const userId = String(user._id);

  console.log('\n=== ACCOUNT');
  for (const k of Object.keys(safe)) if (k in user) show(k, user[k]);

  console.log('\n=== MINING RECORD (userminings)');
  const minings = await db.collection('userminings').find({ user: userId }).toArray();
  if (!minings.length) console.log('  !! NO MINING RECORD -- mining cannot start without one');
  if (minings.length > 1) console.log(`  !! ${minings.length} MINING RECORDS for one user -- reads may hit the wrong one`);
  for (const m of minings) {
    for (const k of ['_id', 'mining_isactive', 'hashpower', 'claimedHashpower', 'purchasedHashpower', 'start_time', 'stop_time',
      'local_start_time', 'local_stop_time', 'offset', 'timezone', 'rewarded_ads_watched', 'thirty_gh_rewarded_ads_watched',
      'random_ads_watched', 'daily_reward_claimed', 'lastResetTime', 'dailyVideoRequirement', 'lossTracking', 'createdAt', 'updatedAt']) {
      if (k in m) show(k, m[k]);
    }
    console.log('  -- streak');
    show('streakDays', m.streakDays);
    show('streakLastDate', m.streakLastDate);
    show('streakClaimedMilestones', m.streakClaimedMilestones);
    const now = new Date(); const today = now.toISOString().slice(0, 10);
    const y = new Date(now - 864e5).toISOString().slice(0, 10);
    const s = m.streakLastDate;
    show('streak state (UTC dates)', !s ? 'never counted' : s === today ? 'counted today' : s === y ? 'counted yesterday -- continues if counted today' : `last counted ${s} -- will RESET to 1 on next claim`);
    for (const k of ['tradingHistory', 'spinHistory', 'memoryMatchHistory']) if (Array.isArray(m[k])) show(`${k} entries`, m[k].length);
  }

  console.log('\n=== MINING SESSIONS since --since (newest first)');
  const sessions = await db.collection('miningsessions').find({ user_id: userId, createdAt: { $gte: args.since } }).sort({ createdAt: -1 }).limit(20).toArray();
  if (!sessions.length) console.log('  (none)');
  for (const s of sessions) console.log(`  ${iso(s.start_time)} -> ${iso(s.end_time)} | status ${s.status} | ${s.hash_power} GH/s | ads ${s.ads_watched}`);

  console.log('\n=== DAILY REWARD CLAIMS since --since');
  for (const c of ['dailyrewardclaims', 'dailyrewardclaimhistories']) {
    const rows = await db.collection(c).find({ userId, claimedAt: { $gte: args.since } }).sort({ claimedAt: -1 }).limit(20).toArray();
    console.log(`  ${c}: ${rows.length ? rows.map(r => iso(r.claimedAt)).join(', ') : '(none)'}`);
  }

  console.log(`\n=== WHAT THE APP ASKED AND WHAT THE SERVER ANSWERED (nginx, since ${iso(args.since)})`);
  console.log('  "(ip)" = a POST from this user\'s IP address; bodies are not logged, so it is probably theirs but not certain.');
  const hits = readNginx(args.nginxDir, userId, args.since);
  if (hits === null) console.log(`  (cannot read ${args.nginxDir} -- run as root)`);
  else if (!hits.length) console.log('  !! NO REQUESTS carrying this user id -- the app is not reaching this server as this user');
  else {
    const byDay = new Map();
    for (const h of hits) {
      const day = h.at.toISOString().slice(0, 10);
      const key = `${h.method} ${h.path} -> ${h.status}`;
      if (!byDay.has(day)) byDay.set(day, new Map());
      byDay.get(day).set(key, (byDay.get(day).get(key) || 0) + 1);
    }
    for (const [day, counts] of byDay) {
      console.log(`  ${day}`);
      for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)} x  ${k}${Number(k.match(/-> (\d{3})/)?.[1]) >= 400 ? '   <-- FAILED' : ''}`);
    }
    const failed = hits.filter(h => h.status >= 400);
    console.log(`\n  failed answers: ${failed.length} of ${hits.length}. Last 15:`);
    for (const h of failed.slice(-15)) console.log(`     ${iso(h.at)}  ${h.status}  ${h.method} ${h.path}  [${h.ua}]`);
    const apps = [...new Set(hits.map(h => h.ua))];
    console.log(`\n  app versions / clients seen: ${apps.join(' | ')}`);
  }
  console.log('');
}

main()
  .catch(err => { console.error(`\nError: ${err.message}`); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
