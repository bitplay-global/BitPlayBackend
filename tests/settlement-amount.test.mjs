/**
 * A settled mining day pays what the user's mining power earned, as the
 * server calculates it, whether or not the app was open.
 *
 * Until 2026-10-15 the cron paid min(app-reported, server-computed). The app
 * only reports while open, so closing it meant being paid its last figure:
 * on 7 Oct 2026 a 943 GH/s account was credited 0.4% of its day. Across the
 * Sep–Oct logs 79% of 9,233 settlements were short.
 *
 * Run: node tests/settlement-amount.test.mjs
 */
import { settlementAmount, maxSettlementBtcPerDay, computeMinedBtcOnDayRollover } from '../helpers/miningDaySettlement.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));

const TZ = 'Asia/Kolkata';
// Session started at 00:00:00.000 local on 7 Oct 2026 (18:30 UTC on 6 Oct).
const start = Date.UTC(2026, 9, 6, 18, 30, 0, 0);
const detail = (hashpower, extra = {}) => ({ hashpower, start_time: start, stockGameBonus: 0, ...extra });
const FULL_DAY = (gh) => gh * 7e-15 * 86400;
const close = (a, b) => Math.abs(a - b) <= Math.max(1e-15, Math.abs(b) * 1e-9);

console.log('\n--- the rule ---');
let r = settlementAmount({ miningDetail: detail(943), userTz: TZ, userOffset: -330, syncedBtc: 1.424e-9 });
check('app closed all day (reported 0.0000000014): the full day is paid', close(r.minedBtc, FULL_DAY(943)), `${r.minedBtc} vs ${FULL_DAY(943)}`);
check('= 0.00000057 BTC for 943 GH/s, 400x what was paid before', r.minedBtc > 5.7e-7 && r.minedBtc < 5.71e-7, String(r.minedBtc));
r = settlementAmount({ miningDetail: detail(943), userTz: TZ, userOffset: -330, syncedBtc: 0 });
check('app never reported at all: still paid', close(r.minedBtc, FULL_DAY(943)));
r = settlementAmount({ miningDetail: detail(284), userTz: TZ, userOffset: -330, syncedBtc: 0.5 });
check('app reporting MORE than earned: server amount, not the app\'s', close(r.minedBtc, FULL_DAY(284)) && r.syncedBtc === 0.5);
r = settlementAmount({ miningDetail: detail(0), userTz: TZ, userOffset: -330, syncedBtc: 1e-7 });
check('no mining power: nothing, whatever the app says', r.minedBtc === 0);

console.log('\n--- what counts as mining power ---');
const withBonus = detail(100, { stockGameBonus: 50, getEffectiveHashpower() { return 125; } });
r = settlementAmount({ miningDetail: withBonus, userTz: TZ, userOffset: -330 });
check('effective power (streak bonus) + stock game bonus, as before', close(r.minedBtc, FULL_DAY(175)), String(r.minedBtc));

console.log('\n--- time ---');
const noon = Date.UTC(2026, 9, 7, 6, 30, 0, 0); // 12:00 local
r = settlementAmount({ miningDetail: detail(1000, { start_time: noon }), userTz: TZ, userOffset: -330 });
check('started at noon: half a day, capped at local midnight', close(r.minedBtc, FULL_DAY(1000) / 2), String(r.minedBtc));
r = settlementAmount({ miningDetail: detail(1000, { start_time: noon }), userTz: null, userOffset: -330 });
check('offset instead of timezone: same answer', close(r.minedBtc, FULL_DAY(1000) / 2));
check('matches the shared day-rollover calculation exactly', settlementAmount({ miningDetail: detail(777), userTz: TZ, userOffset: -330 }).fromElapsed === computeMinedBtcOnDayRollover({ miningDetail: detail(777), userTz: TZ, userOffset: -330 }));

console.log('\n--- ceiling ---');
check('default ceiling 0.00005 BTC/day (~82,000 GH/s)', maxSettlementBtcPerDay() === 0.00005);
r = settlementAmount({ miningDetail: detail(47273), userTz: TZ, userOffset: -330 });
check('the May 2026 forged 47,273 GH/s record stays under it (paid as computed)', !r.capped && close(r.minedBtc, FULL_DAY(47273)));
r = settlementAmount({ miningDetail: detail(1_000_000), userTz: TZ, userOffset: -330 });
check('a 1,000,000 GH/s record is capped at the ceiling', r.capped && r.minedBtc === 0.00005, JSON.stringify(r));
process.env.SETTLEMENT_MAX_BTC_PER_DAY = '0.001';
check('ceiling overridable by env', maxSettlementBtcPerDay() === 0.001);
delete process.env.SETTLEMENT_MAX_BTC_PER_DAY;
r = settlementAmount({ miningDetail: detail(-5), userTz: TZ, userOffset: -330 });
check('negative power: 0, never a debit', r.minedBtc === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
