/**
 * Pays the mining days lost to stuck sessions and repairs their streaks.
 * Used by scripts/compensate-stuck-sessions.js; see that file for how to run.
 *
 * A session stuck active without local_start_time was skipped by the hourly
 * settlement (fixed Sep 2026): its first day is credited when the fixed
 * settlement finally runs, but every later day the user kept the app open
 * earned nothing, and the daily claim -- and with it the streak -- was blocked.
 *
 * Rules, all conservative:
 *  - Only full days strictly between the session's start day and the day the
 *    settlement reset it, and only days the user actually opened the app
 *    (their requests in the nginx logs). Days the logs don't cover are unpaid.
 *  - One day = hashpower shown while stuck x the mining rate x 24h, the same
 *    rate the settlement uses. Sessions reset before their hashpower could be
 *    recorded (found in the settlement log instead) are paid at the user's
 *    own average daily mining over the 7 days before they got stuck.
 *  - Paid exactly as the settlement pays a day: a BalanceHistory row for that
 *    date, the amount added to BTC_DEPOSIT, and the referrer's 5%.
 *  - A day that already has a BalanceHistory row is skipped, so re-running is
 *    safe, and the row and the balance change are written in one transaction.
 *  - Streak: the unbroken run of active days ending at the latest one, but
 *    counting no day before the session got stuck (the bug can't explain a
 *    missed claim before that). Never lowered.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import mongoose from 'mongoose';
import UserMiningDetail from '../models/UserMiningDetails.js';
import Balance from '../models/Balance.js';
import BalanceHistory from '../models/BalanceHistory.js';
import StuckSessionRecovery from '../models/StuckSessionRecovery.js';
import { processReferralRewardForChild } from '../services/referralRewardService.js';
import {
  getSessionStartDateStrFromLocalStart, resolveSessionStartDateStr, getLocalDateStrAt, getHistoryDateFromSessionStartStr,
} from './miningDaySettlement.js';

const BTC_PER_HASHPOWER_PER_SEC = 0.000000000000007; // same as the settlement
export const BTC_PER_GH_PER_DAY = BTC_PER_HASHPOWER_PER_SEC * 86400;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** Record every session that is stuck right now (before a settlement resets it). */
export async function snapshotStuckSessions() {
  const stuck = await UserMiningDetail.find({
    mining_isactive: true,
    start_time: { $gt: 0 },
    local_start_time: { $in: [null, ''] },
  }).lean();
  let recorded = 0;
  for (const m of stuck) {
    const sessionDay = resolveSessionStartDateStr(m);
    if (!sessionDay) continue;
    const r = await StuckSessionRecovery.updateOne(
      { user: String(m.user), startTime: Number(m.start_time) },
      {
        $setOnInsert: {
          sessionDay,
          timezone: m.timezone || null,
          offset: Number.isFinite(Number(m.offset)) ? Number(m.offset) : null,
          hashpower: Number(m.hashpower) || 0,
          source: 'snapshot',
        },
      },
      { upsert: true },
    );
    if (r.upsertedCount) recorded++;
  }
  return { stuck: stuck.length, recorded };
}

/**
 * Stuck sessions the settlement already reset, from its log: each
 * "User X: session has no local_start_time; using start_time's local day D"
 * followed by "Reset user X: ... userDate=T" is a session stuck from D, reset
 * on T. Records them (hashpower unknown) with the user's pre-stuck average
 * daily mining as the pay basis.
 */
export async function recordFromSettlementLog(text) {
  const stuckDay = new Map();
  const found = new Map();
  for (const line of text.split('\n')) {
    let m = line.match(/User ([0-9a-f]{24}): session has no local_start_time; using start_time's local day (\d{4}-\d{2}-\d{2})/);
    if (m) { stuckDay.set(m[1], m[2]); continue; }
    m = line.match(/Reset user ([0-9a-f]{24}): .*userDate=(\d{4}-\d{2}-\d{2})/);
    if (m && stuckDay.has(m[1]) && !found.has(m[1])) {
      found.set(m[1], { sessionDay: stuckDay.get(m[1]), settledDay: m[2] });
    }
  }
  let recorded = 0;
  for (const [user, { sessionDay, settledDay }] of found) {
    const mining = await UserMiningDetail.findOne({ user }).lean();
    const basis = await dailyBasisFromHistory(user, sessionDay);
    // The start time was wiped with the session; a negative key per stuck day
    // keeps these unique without pretending to know it.
    const r = await StuckSessionRecovery.updateOne(
      { user, startTime: -getHistoryDateFromSessionStartStr(sessionDay).getTime() },
      {
        $setOnInsert: {
          sessionDay,
          timezone: mining?.timezone || null,
          offset: Number.isFinite(Number(mining?.offset)) ? Number(mining.offset) : null,
          hashpower: 0,
          dailyBtc: basis.btc,
          basisDays: basis.days,
          source: 'log',
          settledDay,
          settledAt: new Date(),
        },
      },
      { upsert: true },
    );
    if (r.upsertedCount) recorded++;
  }
  return { found: found.size, recorded };
}

/** Average BTC credited per day over the 7 days before `beforeDay` (days with mining only). */
export async function dailyBasisFromHistory(user, beforeDay) {
  const end = getHistoryDateFromSessionStartStr(beforeDay);
  const start = new Date(end.getTime() - 7 * 86400000);
  const rows = await BalanceHistory.find({ user, date: { $gte: start, $lt: end } }).lean();
  const amounts = rows.map(r => parseFloat(r.balances?.BTC?.toString() || '0')).filter(x => x > 0);
  if (!amounts.length) return { btc: null, days: 0 };
  return { btc: amounts.reduce((a, b) => a + b, 0) / amounts.length, days: amounts.length };
}

/**
 * Sets the hashpower a user was stuck at, when it is known from elsewhere
 * (e.g. scripts/diagnose-user.js run before the reset). It then takes
 * precedence over the average. Only for records not yet paid.
 */
export async function setKnownHashpower(user, hashpower) {
  if (!(hashpower > 0)) throw new Error('hashpower must be a positive number');
  const r = await StuckSessionRecovery.updateMany(
    { user, compensatedDays: { $size: 0 } },
    { $set: { hashpower } },
  );
  return r.modifiedCount;
}

/** Local days (YYYY-MM-DD) each tracked user made any request, from nginx access logs. */
export function activeDaysFromLogText(texts, zones) {
  const re = /\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\] "\w+ ([^" ]+)/;
  const out = new Map([...zones.keys()].map(id => [id, new Set()]));
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const ids = line.match(/[0-9a-f]{24}/gi);
      if (!ids) continue;
      const hit = ids.map(i => i.toLowerCase()).find(i => zones.has(i));
      if (!hit) continue;
      const m = line.match(re);
      if (!m) continue;
      const [, dd, mon, yyyy, hh, mi, ss, tz] = m;
      const off = (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
      const at = Date.UTC(+yyyy, MONTHS[mon], +dd, +hh, +mi, +ss) - off * 60000;
      const z = zones.get(hit);
      out.get(hit).add(getLocalDateStrAt(at, z.timezone, z.offset));
    }
  }
  return out;
}

export function readNginxLogs(dir = '/var/log/nginx') {
  const files = fs.readdirSync(dir).filter(f => f.startsWith('access.log')).map(f => path.join(dir, f));
  const texts = [];
  let oldest = null;
  for (const f of files) {
    try {
      const text = f.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(f)).toString('utf8') : fs.readFileSync(f, 'utf8');
      texts.push(text);
      const first = text.match(/\[(\d{2})\/(\w{3})\/(\d{4}):/);
      if (first) {
        const d = `${first[3]}-${String(MONTHS[first[2]] + 1).padStart(2, '0')}-${first[1]}`;
        if (!oldest || d < oldest) oldest = d;
      }
    } catch { /* unreadable rotation, skip */ }
  }
  return { texts, oldest };
}

const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
};

/** Full days strictly between two YYYY-MM-DD days. */
export function daysBetween(fromDay, toDay) {
  const out = [];
  for (let d = addDays(fromDay, 1); d < toDay; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Length of the unbroken run of active days ending at the latest active day. */
export function streakRun(active) {
  if (!active.size) return { days: 0, lastDay: null };
  const lastDay = [...active].sort().at(-1);
  let days = 0;
  for (let d = lastDay; active.has(d); d = addDays(d, -1)) days++;
  return { days, lastDay };
}

/**
 * Works out, for every recorded stuck session, which days to pay and the
 * streak to set. Nothing is written.
 */
export async function planCompensation({ activeDays, logsFrom }) {
  const records = await StuckSessionRecovery.find({}).lean();
  const plans = [];
  for (const rec of records) {
    const mining = await UserMiningDetail.findOne({ user: rec.user }).lean();
    let settledDay = rec.settledDay;
    // A snapshot taken before the fixed settlement ran: once the session is
    // reset, its reset time is the settle day.
    if (!settledDay && mining && Number(mining.start_time) !== rec.startTime && mining.lastResetTime
      && new Date(mining.lastResetTime) > new Date(rec.capturedAt)) {
      settledDay = getLocalDateStrAt(new Date(mining.lastResetTime).getTime(), rec.timezone, rec.offset);
    }
    const plan = { rec, settledDay, pay: [], skipped: [], streak: null };
    plans.push(plan);
    if (!settledDay) { plan.note = 'still stuck -- deploy the fix and wait for the next hourly run'; continue; }

    // Basis, best first: the hashpower they were stuck at; their own average
    // before getting stuck; else what the fix credited for the stuck day itself
    // (a partial day, so a low rate -- never more than they really mined).
    let perDay = null;
    if (rec.hashpower > 0) {
      perDay = rec.hashpower * BTC_PER_GH_PER_DAY;
      plan.basis = `${rec.hashpower} GH/s`;
    } else if (rec.dailyBtc > 0) {
      perDay = rec.dailyBtc;
      plan.basis = `own ${rec.basisDays}-day average`;
    } else {
      const stuckDay = await BalanceHistory.findOne({ user: rec.user, date: getHistoryDateFromSessionStartStr(rec.sessionDay) }).lean();
      const credited = parseFloat(stuckDay?.balances?.BTC?.toString() || '0');
      if (credited > 0) { perDay = credited; plan.basis = 'stuck-day credit (partial day)'; }
    }
    plan.perDay = perDay;
    const active = activeDays.get(rec.user) || new Set();
    for (const day of daysBetween(rec.sessionDay, settledDay)) {
      if (logsFrom && day < logsFrom) { plan.skipped.push(`${day} (before the oldest log)`); continue; }
      if (!active.has(day)) { plan.skipped.push(`${day} (app not opened)`); continue; }
      if (!(perDay > 0)) { plan.skipped.push(`${day} (no mining history before the stuck day to base it on)`); continue; }
      plan.pay.push({ day, btc: perDay });
    }

    // The stuck session can only explain missed claims on days inside it, so
    // only those days count: the run of active days ending at the latest one,
    // taken no further back than the day the session got stuck.
    const run = streakRun(active);
    const inWindow = run.lastDay && run.lastDay >= rec.sessionDay
      ? Math.min(run.days, run.lastDay === rec.sessionDay ? 1 : daysBetween(rec.sessionDay, run.lastDay).length + 2)
      : 0;
    const current = mining?.streakDays ?? 0;
    plan.streak = { before: current, beforeLast: mining?.streakLastDate ?? null, after: Math.max(current, inWindow), afterLast: inWindow > current ? run.lastDay : (mining?.streakLastDate ?? null) };
  }
  return plans;
}

/** Writes a plan: pays each day once, repairs the streak. Returns what was done. */
export async function applyCompensation(plans) {
  const results = [];
  for (const plan of plans) {
    const { rec } = plan;
    const done = { user: rec.user, paidDays: [], btc: 0, alreadyPaid: [], errors: [], streak: null };
    results.push(done);
    if (!plan.settledDay) continue;

    for (const { day, btc } of plan.pay) {
      const date = getHistoryDateFromSessionStartStr(day);
      const session = await mongoose.startSession();
      try {
        let paid = false;
        await session.withTransaction(async () => {
          if (await BalanceHistory.exists({ user: rec.user, date }).session(session)) return;
          const bal = await Balance.findOne({ user: rec.user }).session(session);
          if (!bal) throw new Error('no Balance record');
          bal.BTC_DEPOSIT = mongoose.Types.Decimal128.fromString(
            (parseFloat(bal.BTC_DEPOSIT?.toString() || '0') + btc).toFixed(16));
          await bal.save({ session });
          await BalanceHistory.create([{ user: rec.user, date, balances: { BTC: mongoose.Types.Decimal128.fromString(btc.toFixed(16)) } }], { session });
          paid = true;
        });
        if (paid) {
          done.paidDays.push(day); done.btc += btc;
          await processReferralRewardForChild(rec.user, btc, date).catch(e => done.errors.push(`${day} referral: ${e.message}`));
        } else {
          done.alreadyPaid.push(day);
        }
      } catch (e) {
        done.errors.push(`${day}: ${e.message}`);
      } finally {
        session.endSession();
      }
    }

    if (plan.streak && plan.streak.after > plan.streak.before) {
      // Only ever raise it, even if the record changed since planning.
      await UserMiningDetail.updateOne(
        { user: rec.user, $or: [{ streakDays: { $lt: plan.streak.after } }, { streakDays: null }] },
        { $set: { streakDays: plan.streak.after, streakLastDate: plan.streak.afterLast } },
      );
      done.streak = plan.streak;
    }

    await StuckSessionRecovery.updateOne(
      { _id: rec._id },
      {
        $addToSet: { compensatedDays: { $each: done.paidDays } },
        $inc: { compensatedBtc: done.btc },
        $set: { streakBefore: plan.streak?.before ?? null, streakAfter: plan.streak?.after ?? null },
      },
    );
  }
  return results;
}
