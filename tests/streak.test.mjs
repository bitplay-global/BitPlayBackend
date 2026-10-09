/**
 * Streak day-math. Pure unit test, no database.
 * Run: node tests/streak.test.mjs
 */
import { computeStreak, dayStringFromOffset, dayStringFromLocalTime, dayNumber } from '../helpers/streak.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('computeStreak');
{
  let r = computeStreak({ streakDays: 2, streakLastDate: '2026-10-09' }, '2026-10-10');
  check('next day increments', r.streakDays === 3 && r.streakLastDate === '2026-10-10' && r.reason === 'consecutive', JSON.stringify(r));

  r = computeStreak({ streakDays: 2, streakLastDate: '2026-10-09' }, '2026-10-09');
  check('same day is a no-op', r.streakDays === 2 && r.streakLastDate === '2026-10-09' && !r.changed, JSON.stringify(r));

  r = computeStreak({ streakDays: 2, streakLastDate: '2026-10-10' }, '2026-10-09');
  check('last date ahead of today (client ahead of server) does NOT reset', r.streakDays === 2 && r.streakLastDate === '2026-10-10' && !r.changed, JSON.stringify(r));

  r = computeStreak({ streakDays: 9, streakLastDate: '2026-10-07' }, '2026-10-09');
  check('missed a day resets to 1', r.streakDays === 1 && r.streakLastDate === '2026-10-09' && r.reason === 'gap', JSON.stringify(r));

  r = computeStreak({ streakDays: 32, streakLastDate: null }, '2026-10-10');
  check('manual edit without last date keeps its days', r.streakDays === 32 && r.streakLastDate === '2026-10-10' && r.reason === 'adopted', JSON.stringify(r));

  r = computeStreak({ streakDays: 32, streakLastDate: 'garbage' }, '2026-10-10');
  check('malformed last date keeps its days', r.streakDays === 32 && r.streakLastDate === '2026-10-10', JSON.stringify(r));

  r = computeStreak({}, '2026-10-10');
  check('fresh record starts at 1', r.streakDays === 1 && r.streakLastDate === '2026-10-10' && r.reason === 'start', JSON.stringify(r));

  r = computeStreak({ streakDays: 5, streakLastDate: '2026-10-09' }, 'not-a-date');
  check('unparseable today leaves record untouched', r.streakDays === 5 && r.streakLastDate === '2026-10-09' && !r.changed, JSON.stringify(r));

  r = computeStreak({ streakDays: 31, streakLastDate: '2026-12-31' }, '2027-01-01');
  check('increments across a year boundary', r.streakDays === 32, JSON.stringify(r));

  r = computeStreak({ streakDays: 3, streakLastDate: '2026-02-28' }, '2026-03-01');
  check('increments across end of February', r.streakDays === 4, JSON.stringify(r));
}

console.log('the two paths now agree (IST user, reward in the early-morning window)');
{
  // 00:30 IST on Oct 10 == 19:00Z on Oct 9. Daily claim stamps the client day.
  let rec = { streakDays: 2, streakLastDate: '2026-10-09' };
  const dailyDay = dayStringFromLocalTime('10/10/2026, 12:30:00 AM');
  check('daily claim parses client day', dailyDay === '2026-10-10', dailyDay);
  rec = { ...rec, ...computeStreak(rec, dailyDay) };
  check('daily claim -> 3', rec.streakDays === 3, JSON.stringify(rec));

  // 01:00 IST Oct 10: ad reward via mining POST. Server clock is 19:30Z Oct 9.
  const postDay = dayStringFromOffset(-330, new Date('2026-10-09T19:30:00Z'));
  check('mining POST derives the same client day from offset', postDay === '2026-10-10', postDay);
  const after = computeStreak(rec, postDay);
  check('ad reward in that window no longer resets', after.streakDays === 3 && !after.changed, JSON.stringify(after));

  // And the old behaviour, for the record: server UTC day was '2026-10-09'.
  const old = computeStreak(rec, '2026-10-09');
  check('even a server-day call is now a no-op, not a reset', old.streakDays === 3 && !old.changed, JSON.stringify(old));
}

console.log('helpers');
{
  check('dayStringFromOffset handles west-of-UTC', dayStringFromOffset(300, new Date('2026-10-10T03:00:00Z')) === '2026-10-09');
  check('dayStringFromOffset rejects non-numbers', dayStringFromOffset('abc') === null);
  check('dayStringFromLocalTime rejects garbage', dayStringFromLocalTime('hello') === null && dayStringFromLocalTime(undefined) === null);
  check('dayStringFromLocalTime rejects impossible dates', dayStringFromLocalTime('40/13/2026, 01:00:00 AM') === null);
  check('dayNumber consecutive days differ by 1', dayNumber('2026-10-10') - dayNumber('2026-10-09') === 1);
  check('dayNumber rejects malformed', dayNumber('2026-1-9') === null && dayNumber('') === null && dayNumber(null) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
