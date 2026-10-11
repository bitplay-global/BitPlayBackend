/**
 * How much mining power (GH/s) a reward request may add. The server decides.
 *
 * The app POSTs `hashpower` as an increment to add, and until this existed the
 * server added whatever arrived. Audit of 2026-10-11 (pm2 logs, ~8,000
 * user-days) found the effect:
 *   - the mining-start reward (+25) was granted on EVERY start, so toggling
 *     mining off and on paid it up to 72 times a day (121 user-days > 20);
 *   - the regular ad counter was written from the app's own number, so
 *     sending a low count reopened the 60-a-day limit (up to 219 a day);
 *   - any other amount was accepted as-is: games, spins, or a forged request.
 *
 * Every request is now classified by its shape (which the current app already
 * sends, so no app update is needed) and each kind has its own server limit:
 *
 *   kind          sent by                         rule
 *   start_reward  HomeScreen, mining started      once per local day, <= 25
 *   ad            HomeScreen regular ad (5.5)     counter must move forward,
 *                                                 60 a day, amount is 5.5
 *   privilege_ad  Super Privileges screen         active privilege required,
 *                                                 tier's amount, 50 a day
 *   game          games, spin, scratch, daily     <= maxGameGrant each,
 *                 rewards, trading                MAX_GAME_GH_PER_DAY a day
 *
 * (The Super Ad Miner track, thirty_gh_rewarded_ads_watched, was already
 * computed by the server and is handled in the route as before.)
 *
 * Days are the user's local day (YYYY-MM-DD, the same day the streak uses) and
 * only ever move forward: a request carrying an earlier day counts against the
 * later day already recorded, so changing the phone's clock or timezone cannot
 * open a second "today".
 */

export const START_REWARD_GH = 25;
export const BASE_AD_GH = 5.5;
export const MAX_REWARDED_ADS_PER_DAY = 60;
export const PRIVILEGE_ADS_PER_DAY = 50;
/** GH/s per privilege-screen ad, by tier. Must match the app's PRIVILEGE_TIERS. */
export const PRIVILEGE_TIER_GH = { "5000pct": 10, "10000pct": 20 };
/** Largest single game or daily-reward grant; the route raises it to the largest DailyReward amount. */
export const DEFAULT_MAX_GAME_GRANT_GH = 10;
/**
 * GH/s a user can collect from games, spins, daily rewards and trading in one
 * day. Every game reward costs an ad; 99% of user-days stayed under ~200, the
 * busiest real player reached ~975 once. Overridable without a deploy.
 */
export function maxGameGhPerDay() {
  const v = Number(process.env.MAX_GAME_GH_PER_DAY);
  return Number.isFinite(v) && v > 0 ? v : 500;
}

const isNum = v => typeof v === "number" && Number.isFinite(v);

/** Which kind of reward a POST /api/user_mining body is asking for. */
export function classifyGrant(body) {
  const hp = Number(body?.hashpower);
  if (!Number.isFinite(hp) || hp <= 0) return "none";
  if (isNum(body.privilege_ads_watched)) return "privilege_ad";
  if (isNum(body.rewarded_ads_watched) && hp >= 5 && hp <= 6) return "ad";
  if (body.mining_isactive === true) return "start_reward";
  return "game";
}

/** Day bookkeeping: the counter for `today`, never letting the day go backwards. */
function dayCounter(storedDay, storedCount, today) {
  // No day recorded yet (records from before this existed): the stored count
  // is taken to be today's, so deploying this doesn't reopen today's limits.
  if (!storedDay) return { day: today, used: Number(storedCount) || 0 };
  if (today && today > storedDay) return { day: today, used: 0 };
  return { day: storedDay, used: Number(storedCount) || 0 };
}

/**
 * Decide one grant. Pure: the route supplies the stored record and context.
 *
 * @param {object} body           request body
 * @param {object|null} record    stored UserMining document (or null)
 * @param {object} ctx
 * @param {string} ctx.today            user's local day, YYYY-MM-DD
 * @param {number[]} [ctx.privilegeGh]  GH/s per ad for each ACTIVE privilege tier
 * @param {number} [ctx.maxGameGrant]   largest single game/daily-reward grant
 * @param {string} [ctx.legacyDay]      local day the record was last written,
 *                                      for records that predate adCountDay
 * @returns {{kind:string, requested:number, granted:number, reason:string|null,
 *            adCapReached:boolean, set:object}}
 *   `set` holds the counter fields to store alongside the grant.
 */
export function decideGrant(body, record, ctx) {
  const kind = classifyGrant(body);
  const requested = Number(body?.hashpower) || 0;
  const today = ctx.today;
  const out = { kind, requested, granted: 0, reason: null, adCapReached: false, set: {} };
  if (kind === "none") return out;

  if (kind === "start_reward") {
    const last = record?.startRewardDay || null;
    if (last && !(today > last)) {
      out.reason = "start reward already granted today";
      return out;
    }
    out.granted = Math.min(requested, START_REWARD_GH);
    out.set.startRewardDay = today;
    return out;
  }

  if (kind === "ad") {
    const { day, used } = adCounter(record, today, ctx.legacyDay);
    out.set.adCountDay = day;
    out.set.rewarded_ads_watched = used;
    if (used >= MAX_REWARDED_ADS_PER_DAY) {
      out.reason = "daily ad limit reached";
      out.adCapReached = true;
      return out;
    }
    if (!(body.rewarded_ads_watched > used)) {
      out.reason = "ad counter did not move forward (replay)";
      return out;
    }
    out.granted = BASE_AD_GH;
    out.set.rewarded_ads_watched = used + 1;
    return out;
  }

  if (kind === "privilege_ad") {
    const tiers = (ctx.privilegeGh || []).filter(g => g > 0);
    if (!tiers.length) {
      out.reason = "no active privilege";
      return out;
    }
    const { day, used } = dayCounter(record?.privilegeAdsDay, record?.privilegeAdsToday, today);
    out.set.privilegeAdsDay = day;
    out.set.privilegeAdsToday = used;
    if (used >= PRIVILEGE_ADS_PER_DAY) {
      out.reason = "daily privilege ad limit reached";
      out.adCapReached = true;
      return out;
    }
    // The amount must be one of the user's own active tiers; anything else
    // gets the smallest of them.
    out.granted = tiers.includes(requested) ? requested : Math.min(...tiers);
    if (out.granted !== requested) out.reason = "amount is not one of the user's active privilege tiers";
    out.set.privilegeAdsToday = used + 1;
    return out;
  }

  // game
  return applyGameBudget(out, record, today, requested, ctx.maxGameGrant);
}

/**
 * Charge a game-type grant (also trading claims) against the day's budget.
 * Mutates and returns `out`, setting gameGhDay/gameGhToday in out.set.
 */
export function applyGameBudget(out, record, today, requested, maxGameGrant = DEFAULT_MAX_GAME_GRANT_GH) {
  const { day, used } = dayCounter(record?.gameGhDay, record?.gameGhToday, today);
  const perGrant = Math.max(DEFAULT_MAX_GAME_GRANT_GH, Number(maxGameGrant) || 0);
  const remaining = Math.max(0, maxGameGhPerDay() - used);
  out.granted = Math.min(Math.max(0, requested), perGrant, remaining);
  if (out.granted < requested) {
    out.reason = remaining <= 0 ? "daily game reward limit reached"
      : requested > perGrant ? `more than the largest game reward (${perGrant})`
        : "daily game reward limit reached";
  }
  out.set.gameGhDay = day;
  out.set.gameGhToday = used + out.granted;
  return out;
}

/**
 * Today's regular-ad count. The stored count is the server's own; the app's
 * number only has to be ahead of it. A count from an earlier day is 0 today,
 * also for a session that stopped before midnight and so was never reset by
 * the settlement.
 */
export function adCounter(record, today, legacyDay = null) {
  return dayCounter(record?.adCountDay || legacyDay, record?.rewarded_ads_watched, today);
}

/** GH/s per ad for each active privilege tier, from AdMultiplierPrivilege rows. */
export function privilegeGhFromRows(rows) {
  return [...new Set((rows || []).map(r => PRIVILEGE_TIER_GH[r.tier]).filter(Boolean))];
}
