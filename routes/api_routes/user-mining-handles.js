import express from 'express';
import UserMiningDetail from "../../models/UserMiningDetails.js";
import Balance from "../../models/Balance.js";
import DailyFreeMiner from "../../models/DailyMiner.js";
import AdMultiplierPrivilege from "../../models/AdMultiplierPrivilege.js";
import {
  getUserLocalDateStr,
  getSessionStartDateStrFromLocalStart,
  computeMinedBtcOnDayRollover,
  formatLocalStartTime,
  getLocalDateStrAt,
} from "../../helpers/miningDaySettlement.js";

const router = express.Router();


const BTC_PER_HASHPOWER_PER_SEC = 0.0000000000000070;
const MAX_MINING_DURATION_MS = 24 * 60 * 60 * 1000;
/** Max rewarded-video claims/day on the regular (flat 5.5 Gh/s) track — must match the client's
 *  MAX_VIDEO_CLAIMS_PER_TRACK_PER_DAY in HomeScreen.tsx. */
const MAX_REWARDED_ADS_PER_TRACK = 60;
/** Max claims/day on the Super Ad Miner (thirty_gh, privilege-boosted) track — must match the
 *  client's MAX_SUPER_AD_MINER_CLAIMS_PER_DAY in HomeScreen.tsx. */
const MAX_SUPER_AD_MINER_CLAIMS_PER_DAY = 30;
/** Base reward per ad claim (Gh/s), before any privilege multiplier. Must match the client's
 *  BASE_HASHPOWER_PER_AD in HomeScreen.tsx. */
const BASE_HASHPOWER_PER_AD = 5.5;
// const MAX_MINING_DURATION_MS = 10 * 60 * 1000;

const isSameLocalDay = (date1, date2) =>
  date1.getFullYear() === date2.getFullYear() &&
  date1.getMonth() === date2.getMonth() &&
  date1.getDate() === date2.getDate();


const incrementDailyVideoCount = async (req, res) => {
  try {
    const { user } = req.body;

    let miningDetails = await UserMiningDetail.findOne({ user });

    if (!miningDetails) {
      return res.status(404).json({
        success: false,
        message: 'Mining details not found'
      });
    }

    miningDetails.incrementDailyVideoCount();

    // Reset consecutive failures if they meet requirement
    if (miningDetails.metDailyRequirement()) {
      miningDetails.dailyVideoRequirement.consecutiveFailures = 0;
    }

    await miningDetails.save();

    res.status(200).json({
      success: true,
      message: 'Video count incremented',
      daily_progress: miningDetails.getDailyProgress()
    });
  } catch (error) {
    console.error('Error incrementing video count:', error);
    res.status(500).json({
      success: false,
      message: 'Error incrementing video count',
      error: error.message
    });
  }
};

/**
 * @desc    Increment daily ads watched for loss offset
 * @route   POST /api/user_mining/increment-loss-ad
 * @access  Public
 */
const incrementLossOffsetAd = async (req, res) => {
  try {
    const { user } = req.body;

    let miningDetails = await UserMiningDetail.findOne({ user });

    if (!miningDetails) {
      return res.status(404).json({
        success: false,
        message: 'Mining details not found'
      });
    }

    // Increment ads watched
    miningDetails.incrementLossOffsetAds();
    const lossReduced = miningDetails.reduceCumulativeLoss();
    await miningDetails.save();

    res.status(200).json({
      success: true,
      message: lossReduced
        ? `Loss offset ad count incremented. Loss reduced by ${miningDetails.lossTracking.daily_loss_offset}%!`
        : 'Loss offset ad count incremented',
      daily_ads_watched: miningDetails.lossTracking.daily_ads_watched,
      cumulative_loss: miningDetails.lossTracking.cumulative_loss,
      loss_reduced: lossReduced
    });
  } catch (error) {
    console.error('Error incrementing loss offset ads:', error);
    res.status(500).json({
      success: false,
      message: 'Error incrementing ad count',
      error: error.message
    });
  }
};

/**
 * @desc    Get daily video progress
 * @route   GET /api/user_mining/daily-progress/:user
 * @access  Public
 */
const getDailyProgress = async (req, res) => {
  try {
    const { userId } = req.params;

    // Fix: Use UserMiningDetail (singular) and query by { user: userId }
    let miningDetails = await UserMiningDetail.findOne({ user: userId });

    if (!miningDetails) {
      return res.status(404).json({
        success: false,
        message: 'Mining details not found'
      });
    }


    // Get progress
    const dailyProgress = typeof miningDetails.getDailyProgress === 'function'
      ? miningDetails.getDailyProgress()
      : {
        videosWatched: miningDetails.dailyVideoRequirement?.videosWatched || 0,
        required: miningDetails.dailyVideoRequirement?.required || 5,
        met: (miningDetails.dailyVideoRequirement?.videosWatched || 0) >=
          (miningDetails.dailyVideoRequirement?.required || 5),
        consecutiveFailures: miningDetails.dailyVideoRequirement?.consecutiveFailures || 0,
        lastResetDate: miningDetails.dailyVideoRequirement?.lastResetDate
      };

    res.status(200).json({
      success: true,
      daily_progress: dailyProgress
    });
  } catch (error) {
    console.error('Error getting daily progress:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving daily progress',
      error: error.message
    });
  }
};

// GET user mining details by user
router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { local_time } = req.query; // client local time
    let mining_details = await UserMiningDetail.findOne({ user: userId });
    if (!mining_details) {
      return res.status(404).json({ success: false, message: "Mining details not found.", daily_reward_claimed: false });
    }

    // Migration logic: if claimedHashpower and purchasedHashpower are not set, initialize them
    // Assume all existing hashpower is claimed (since we don't have historical purchase data)
    if (mining_details.claimedHashpower === undefined || mining_details.purchasedHashpower === undefined) {
      const existingHashpower = mining_details.hashpower || 0;
      const currentPurchased = mining_details.purchasedHashpower || 0;
      const currentClaimed = mining_details.claimedHashpower || 0;

      // Only set if undefined - don't overwrite existing values
      if (mining_details.claimedHashpower === undefined) {
        mining_details.claimedHashpower = Math.max(0, existingHashpower - currentPurchased);
      }
      if (mining_details.purchasedHashpower === undefined) {
        mining_details.purchasedHashpower = 0;
      }

      mining_details.hashpower = (mining_details.claimedHashpower || 0) + (mining_details.purchasedHashpower || 0);
      await mining_details.save();
      console.log(`Migrated user ${userId}: claimed=${mining_details.claimedHashpower}, purchased=${mining_details.purchasedHashpower}`);
    }


    // // DISABLED: Migration logic removed - loss tracking is no longer active
    // // Old migration code has been removed to prevent any loss tracking initialization

    // // Validate hashpower: total must be >= claimed + purchased (extra is streak bonus from POST)
    // const claimed = mining_details.claimedHashpower || 0;
    // const purchased = mining_details.purchasedHashpower || 0;
    // const minHashpower = claimed + purchased;

    // if (mining_details.hashpower < minHashpower) {
    //   console.warn(`⚠️ Hashpower too low! DB total=${mining_details.hashpower}, min=${minHashpower} (claimed=${claimed} + purchased=${purchased})`);
    //   mining_details.hashpower = minHashpower;
    //   await mining_details.save();
    //   console.log(`✅ Fixed hashpower: ${minHashpower}`);
    // }
    // // If hashpower > minHashpower, the difference is streak bonus (added in POST); do not strip it.

    // // Cumulative loss tracking is no longer active
    // if (mining_details.purchasedHashpower > 0) {
    //   if (typeof mining_details.checkAndApplyDailyLoss === 'function') {
    //     mining_details.checkAndApplyDailyLoss();
    //     await mining_details.save();
    //     console.log(`✅ Daily loss check completed for user ${userId}: cumulative_loss=${mining_details.lossTracking.cumulative_loss}%, daily_ads=${mining_details.lossTracking.daily_ads_watched}`);
    //   }
    // }

    // // Effective hashpower: stored hashpower already includes streak (from POST); only loss is applied here
    // let effectiveHashpower = mining_details.hashpower;
    // if (typeof mining_details.getEffectiveHashpower === 'function') {
    //   effectiveHashpower = mining_details.getEffectiveHashpower();
    // }
    // const streakDays = mining_details.streakDays ?? 0;
    // const streakBonusGh = typeof mining_details.getStreakBonusGh === 'function'
    //   ? mining_details.getStreakBonusGh()
    //   : 0;


    // DISABLED: Migration logic removed - loss tracking is no longer active
    // Old migration code has been removed to prevent any loss tracking initialization

    // Validate and fix hashpower relationship: ALWAYS ensure total = claimed + purchased
    const claimed = mining_details.claimedHashpower || 0;
    const purchased = mining_details.purchasedHashpower || 0;
    const calculatedTotal = claimed + purchased;

    if (mining_details.hashpower !== calculatedTotal) {
      console.warn(`⚠️ Hashpower mismatch detected! DB total=${mining_details.hashpower}, should be ${calculatedTotal} (claimed=${claimed} + purchased=${purchased})`);
      mining_details.hashpower = calculatedTotal;
      await mining_details.save();
      console.log(`✅ Fixed hashpower: ${calculatedTotal}`);
    }

    // Cumulative loss tracking is no longer active
    if (mining_details.purchasedHashpower > 0) {
      if (typeof mining_details.checkAndApplyDailyLoss === 'function') {
        mining_details.checkAndApplyDailyLoss();
        await mining_details.save();
        console.log(`✅ Daily loss check completed for user ${userId}: cumulative_loss=${mining_details.lossTracking.cumulative_loss}%, daily_ads=${mining_details.lossTracking.daily_ads_watched}`);
      }
    }

    // Use effective hashpower (cumulative loss applied + streak bonus)
    let effectiveHashpower = mining_details.hashpower;
    if (typeof mining_details.getEffectiveHashpower === 'function') {
      effectiveHashpower = mining_details.getEffectiveHashpower();
    }
    const streakDays = mining_details.streakDays ?? 0;
    const streakBonusGh = typeof mining_details.getStreakBonusGh === 'function'
      ? mining_details.getStreakBonusGh()
      : 0;

    const serverStockGameBonus = mining_details.stockGameBonus || 0;
    const totalMiningPower = effectiveHashpower + serverStockGameBonus;

    const { hashpower, offset, local_start_time } = mining_details;
    const userOffsetMin = Number(offset) || 0;

    console.log("UserID:", userId, "Hashpower:", hashpower, "LocalStartTime:", local_start_time);
    console.log("Current Local Time:", local_time);


    // IMPORTANT: Only run day-boundary/mined-BTC calculations when mining is ACTIVE.
    // Purchased hashpower can be >0 even when mining is inactive, and stale `local_start_time`
    // would otherwise cause unintended resets when user simply revisits the app.
    const streakTiers = UserMiningDetail.getStreakTiers ? UserMiningDetail.getStreakTiers() : [];

    if (!mining_details.mining_isactive || !hashpower || hashpower <= 0 || !local_start_time) {
      return res.json({
        success: true,
        mining_details: {
          ...mining_details.toObject(),
          effective_hashpower: effectiveHashpower,
          streak_days: streakDays,
          streak_bonus_gh: streakBonusGh,
          streak_tiers: streakTiers
        },
        calculated_btc: 0,
        time_remaining: 0,
        message: "Mining not active or invalid hashpower.",
        daily_reward_claimed: false
      });
    }

    // Parse DB local_start_time
    const dbParts = local_start_time.match(/\d+/g); // [month, day, year, hour, min, sec]
    const dbAmPm = /AM|PM/i.exec(local_start_time)?.[0]?.toUpperCase();
    let dbHour = parseInt(dbParts[3], 10);
    if (dbAmPm === "PM" && dbHour < 12) dbHour += 12;
    if (dbAmPm === "AM" && dbHour === 12) dbHour = 0;

    const startday = parseInt(dbParts[0], 10);
    const startmonth = parseInt(dbParts[1], 10) - 1;
    const startyear = parseInt(dbParts[2], 10);

    const dbLocalStart = new Date(startyear, startmonth, startday, dbHour, parseInt(dbParts[4]), parseInt(dbParts[5]));

    // Parse client local_time
    const clientParts = local_time.match(/\d+/g);
    const clientAmPm = /AM|PM/i.exec(local_time)?.[0]?.toUpperCase();
    let clientHour = parseInt(clientParts[3], 10);
    if (clientAmPm === "PM" && clientHour < 12) clientHour += 12;
    if (clientAmPm === "AM" && clientHour === 12) clientHour = 0;

    const day = parseInt(clientParts[0], 10);
    const month = parseInt(clientParts[1], 10) - 1;
    const year = parseInt(clientParts[2], 10);

    const clientLocalTime = new Date(year, month, day, clientHour, parseInt(clientParts[4]), parseInt(clientParts[5]));

    // Rollover detection: same as hourly cron (timezone/offset in DB + session start date string from local_start_time)
    const userTodayStr = getUserLocalDateStr(mining_details.timezone, mining_details.offset);
    const sessionStartDateStr = getSessionStartDateStrFromLocalStart(mining_details.local_start_time);
    const shouldSettle = sessionStartDateStr
      ? (userTodayStr > sessionStartDateStr)
      : !isSameLocalDay(dbLocalStart, clientLocalTime);

    // Same calendar day (no settlement): live mined amount for the UI
    const startMs = Number(mining_details.start_time) || 0;
    let calculated_btc = 0;

    console.log("DB Local Time: ", dbLocalStart);
    console.log("Client Local Time: ", clientLocalTime);
    console.log("userTodayStr:", userTodayStr, "sessionStartDateStr:", sessionStartDateStr, "shouldSettle:", shouldSettle);

    if (!shouldSettle) {
      const userBal = await Balance.findOne({ user: userId });
      const syncedBtc = parseFloat(userBal?.BTC?.toString() || "0");
      const endCapMs = Math.min(clientLocalTime.getTime(), startMs + MAX_MINING_DURATION_MS);
      const elapsedMs = Math.max(0, endCapMs - startMs);
      const miningDurationSec = elapsedMs / 1000;
      const fromElapsed = totalMiningPower * BTC_PER_HASHPOWER_PER_SEC * miningDurationSec;
      calculated_btc = Math.max(syncedBtc, fromElapsed);
      console.log(
        `SameDay: synced=${syncedBtc}, fromElapsed=${fromElapsed}, used=${calculated_btc}, totalMiningPower=${totalMiningPower}, elapsed=${miningDurationSec}s`
      );
    } else {
      // Day rolled over → DO NOT settle here.
      //
      // SECURITY HARDENING: BalanceHistory creation, BTC_DEPOSIT credit, mining
      // state reset, referral reward processing, and the mining-stopped
      // notification are ALL handled exclusively by the hourly cron in
      // `cronJobs.js`. This API path is read-only with respect to the ledger
      // so no client request can produce a BalanceHistory entry or move BTC
      // into the withdrawable pool.
      //
      // For display we return the conservative minimum of (syncedBtc,
      // fromElapsed) capped at the user's local midnight — the same value the
      // cron will write — so the UI shows a stable end-of-day amount while the
      // settlement is queued.
      const user_balance = await Balance.findOne({ user: userId });
      const userTz = mining_details.timezone || null;
      const userOffset = mining_details.offset;
      const syncedBtc = parseFloat(user_balance?.BTC?.toString() || "0");
      const fromElapsed = computeMinedBtcOnDayRollover({ miningDetail: mining_details, userTz, userOffset });
      calculated_btc = Math.min(syncedBtc, fromElapsed);

      console.log(
        `Day rollover detected for ${userId} — settlement deferred to cron. synced=${syncedBtc}, fromElapsed=${fromElapsed}, displayMin=${calculated_btc}, userToday=${userTodayStr}, sessionDay=${sessionStartDateStr}`
      );
    }

    const nextLocalMidnight = new Date(clientLocalTime.getFullYear(), clientLocalTime.getMonth(), clientLocalTime.getDate() + 1);
    const time_remaining_secs = Math.max(0, Math.floor((nextLocalMidnight - clientLocalTime) / 1000));

    console.log("Remaining Time: ", time_remaining_secs);
    console.log(`Time remaining: ${(time_remaining_secs / 60).toFixed(2)} mins (${(time_remaining_secs / 3600).toFixed(2)} hrs)`);


    var DailyRewardClaimed = false;

    const existingClaim = await DailyFreeMiner.findOne({
      userId
    });

    if (existingClaim) {
      DailyRewardClaimed = true;
    }

    // Streak is never mutated by this GET handler (settlement is cron-only).
    const finalStreakDays = mining_details.streakDays ?? 0;
    const finalStreakBonusGh = typeof mining_details.getStreakBonusGh === 'function'
      ? mining_details.getStreakBonusGh() : 0;

    return res.json({
      success: true,
      mining_details: {
        ...mining_details.toObject(),
        effective_hashpower: effectiveHashpower,
        stock_game_bonus: mining_details.stockGameBonus || 0,
        total_mining_power: effectiveHashpower + (mining_details.stockGameBonus || 0),
        streak_days: finalStreakDays,
        streak_bonus_gh: finalStreakBonusGh,
        streak_tiers: streakTiers
      },
      calculated_btc: parseFloat(calculated_btc.toFixed(16)),
      message: "Mining details fetched successfully (local time based).",
      time_remaining: time_remaining_secs ?? 0,
      daily_reward_claimed: DailyRewardClaimed
    });
  } catch (err) {
    console.error("Error fetching mining details:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
      time_remaining: 0,
      daily_reward_claimed: false
    });
  }
});

// POST create or update user mining details
router.post("/", async (req, res) => {
  try {
    const {
      user_id,
      hashpower,
      mining_isactive,
      rewarded_ads_watched,
      thirty_gh_rewarded_ads_watched,
      random_ads_watched,
      start_time,
      stop_time,
      local_start_time,
      local_stop_time,
      // Backward/forward-compat: some clients may send `local_end_time`
      local_end_time,
      offset,
      timezone,
      stock_game_bonus
    } = req.body;

    if (!user_id) {
      return res.status(400).json({ success: false, message: "user id is required" });
    }

    let existingRecord = await UserMiningDetail.findOne({ user: user_id });

    const updateData = {};
    const incomingMiningActive =
      typeof mining_isactive === "boolean"
        ? mining_isactive
        : (existingRecord?.mining_isactive ?? false);

    // Cap ad counters and strip fraudulent hashpower when daily cap already reached.
    // (thirty_gh's cappedThirtyGh is fully recomputed below with strict +1 validation —
    // this Math.min is only the fallback for the regular rewarded_ads_watched track.)
    let cappedRewarded = rewarded_ads_watched;
    let cappedThirtyGh = thirty_gh_rewarded_ads_watched;
    // Set when a claim is refused for having already hit the daily ad cap on its
    // track, so the response can tell the app apart from a real grant of 0 --
    // otherwise this looked identical to a normal successful call and the app
    // had no way to show "come back tomorrow" instead of a dead-looking button.
    let adCapReached = false;
    if (typeof rewarded_ads_watched === "number") {
      cappedRewarded = Math.min(rewarded_ads_watched, MAX_REWARDED_ADS_PER_TRACK);
    }

    // DISABLED: Migration logic removed - loss tracking is no longer active

    // The thirty_gh_* track is the only one that carries a paid privilege multiplier,
    // and (confirmed against the client) this field is never reused for any other
    // grant type — so it's safe to fully validate rather than just cap it.
    // The client's `hashpower` value for this track is never trusted: the reward is
    // always computed here from BASE_HASHPOWER_PER_AD * effective multiplier, and the
    // counter is only allowed to advance by exactly 1 per request.
    let thirtyGhIsValidClaim = false;
    let thirtyGhServerReward = 0;
    if (typeof thirty_gh_rewarded_ads_watched === "number") {
      const prevThirtyGh = existingRecord?.thirty_gh_rewarded_ads_watched || 0;
      // Accept any forward progress (> prev), not just an exact +1 — the client updates
      // its local counter optimistically before this request completes, so a prior
      // dropped/failed request can leave it legitimately ahead of our stored count.
      // A same-or-lower value is a retry/replay of an already-processed claim and is
      // correctly ignored (no double-grant). Either way, the STORED counter only ever
      // advances by exactly 1 per request here, regardless of how large a jump the
      // client claims — so this can't be abused to skip ahead in a single call.
      thirtyGhIsValidClaim =
        thirty_gh_rewarded_ads_watched > prevThirtyGh &&
        prevThirtyGh < MAX_SUPER_AD_MINER_CLAIMS_PER_DAY;
      if (thirtyGhIsValidClaim) {
        const effectiveMultiplier = await AdMultiplierPrivilege.getEffectiveMultiplier(user_id);
        thirtyGhServerReward = BASE_HASHPOWER_PER_AD * effectiveMultiplier;
      }
      cappedThirtyGh = thirtyGhIsValidClaim ? prevThirtyGh + 1 : prevThirtyGh;
    }

    // Handle hashpower update: separate claimed from purchased; add streak bonus to total
    if (typeof hashpower === "number" || typeof thirty_gh_rewarded_ads_watched === "number") {
      const currentPurchased = existingRecord?.purchasedHashpower || 0;
      const currentClaimed = existingRecord?.claimedHashpower || 0;
      // Always treat incoming hashpower as the amount to add to claimed (unless ad cap blocks it)
      let claimedToAdd = typeof hashpower === "number" ? hashpower : 0;
      if (typeof thirty_gh_rewarded_ads_watched === "number") {
        // Server-computed reward replaces whatever the client sent for this track.
        claimedToAdd = thirtyGhServerReward;
        if (!thirtyGhIsValidClaim && (existingRecord?.thirty_gh_rewarded_ads_watched || 0) >= MAX_SUPER_AD_MINER_CLAIMS_PER_DAY) {
          adCapReached = true;
        }
      } else if (claimedToAdd > 0) {
        if (typeof rewarded_ads_watched === "number") {
          const prev = existingRecord?.rewarded_ads_watched || 0;
          // First track: ~5.5 Gh/s per video — do not block daily reward (25 Gh/s) or other large grants
          const isFivePointFiveAd = claimedToAdd <= 6 && claimedToAdd >= 5;
          if (prev >= MAX_REWARDED_ADS_PER_TRACK && isFivePointFiveAd) {
            claimedToAdd = 0;
            adCapReached = true;
          }
        }
      }
      const newClaimed = currentClaimed + claimedToAdd;
      let totalHashpower = newClaimed + currentPurchased;

      // Update streak when user sends daily claim (hashpower): use client local date when available
      let todayStr;
      if (typeof local_start_time === "string" && local_start_time.trim() !== "") {
        const parts = local_start_time.match(/\d+/g);
        if (parts && parts.length >= 3) {
          const day = parseInt(parts[0], 10);
          const month = parseInt(parts[1], 10) - 1;
          const year = parseInt(parts[2], 10);
          const d = new Date(year, month, day);
          todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        }
      }
      if (!todayStr) {
        const now = new Date();
        todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      }
      const [y, m, d] = todayStr.split("-").map(Number);
      const yesterday = new Date(y, m - 1, d);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
      const last = existingRecord?.streakLastDate ?? "";
      if (last === todayStr) {
        // Already counted today
      } else if (last === yesterdayStr) {
        updateData.streakDays = (existingRecord?.streakDays || 0) + 1;
        updateData.streakLastDate = todayStr;
        console.log(`✅ Streak updated (consecutive): ${updateData.streakDays} days`);
      } else {
        updateData.streakDays = 1;
        updateData.streakLastDate = todayStr;
        console.log(`✅ Streak reset/start: 1 day (last=${last || "none"})`);
      }

      // Add streak bonus to total (use updated streak if we just set it)
      const streakDaysForBonus = updateData.streakDays ?? existingRecord?.streakDays ?? 0;
      const streakBonusGh = (() => {
        const tiers = UserMiningDetail.getStreakTiers ? UserMiningDetail.getStreakTiers() : [];
        for (const tier of tiers) {
          if (streakDaysForBonus >= (tier.minDays ?? 0)) return tier.bonusGh ?? 0;
        }
        return 0;
      })();
      if (streakBonusGh > 0) {
       const newTotalHashpower = totalHashpower + streakBonusGh;
      }

      updateData.claimedHashpower = newClaimed;
      updateData.purchasedHashpower = currentPurchased; // Keep existing purchased
      // updateData.hashpower = newTotalHashpower; // total = claimed + purchased + streak
      updateData.hashpower = totalHashpower; // total = claimed + purchased

      console.log(`✅ POST update: total=${totalHashpower}, claimed=${newClaimed}, purchased=${currentPurchased}, streak=${streakBonusGh} (days=${streakDaysForBonus})`);
    }

    if (typeof rewarded_ads_watched === "number") updateData.rewarded_ads_watched = cappedRewarded;
    if (typeof thirty_gh_rewarded_ads_watched === "number") updateData.thirty_gh_rewarded_ads_watched = cappedThirtyGh;
    if (typeof random_ads_watched === "number") updateData.random_ads_watched = random_ads_watched;
    if (typeof mining_isactive === "boolean") updateData.mining_isactive = mining_isactive;
    if (typeof stop_time === "number") updateData.stop_time = stop_time;


    // Start/stop local timestamps
    // - When starting a NEW session (previously inactive), allow setting a fresh local_start_time.
    // - When stopping, clear local_start_time and set local_stop_time.
    // This prevents stale local_start_time causing unintended "midnight" resets on next screen focus.
    const resolvedLocalStopTime =
      (typeof local_stop_time === "string" && local_stop_time.trim() !== "")
        ? local_stop_time
        : ((typeof local_end_time === "string" && local_end_time.trim() !== "")
          ? local_end_time
          : null);

    if (incomingMiningActive) {
      // Clear any previous stop time when mining becomes active
      updateData.local_stop_time = null;

      if (typeof local_start_time === "string" && local_start_time.trim() !== "") {
        // Only set start time if there isn't one OR the previous session was inactive
        const isNewSession = !existingRecord || !existingRecord.local_start_time || !existingRecord.mining_isactive;
        if (isNewSession) {
          updateData.local_start_time = local_start_time;
        } else {
          updateData.local_start_time = existingRecord.local_start_time;
        }
      }
    } else {
      // Stopping mining: clear start time so GET won't run active-session calculations
      updateData.local_start_time = null;
      if (resolvedLocalStopTime) updateData.local_stop_time = resolvedLocalStopTime;
    }

    if (typeof offset === "number") updateData.offset = offset;
    if (typeof timezone === "string" && timezone.trim() !== "") updateData.timezone = timezone.trim();
    if (typeof stock_game_bonus === "number" && stock_game_bonus >= 0) updateData.stockGameBonus = stock_game_bonus;

    if (typeof start_time === "number") {
      const now = Date.now();

      if (!existingRecord || !existingRecord.start_time) {
        // No record found → set start_time
        updateData.start_time = start_time;
      } else {
        const lastStart = Number(existingRecord.start_time);
        const diff = now - lastStart;
        const twentyFourHours = 24 * 60 * 60 * 1000;

        if (diff >= twentyFourHours) {
          // More than 24h passed → reset start_time
          updateData.start_time = 0;
        } else {
          // Less than 24h → keep the old start_time
          updateData.start_time = existingRecord.start_time;
        }
      }
    }

    // A NEW session must leave here with a usable start. The app omits
    // local_start_time (and can resend the previous day's start_time) when it
    // still holds the old session in memory after midnight; that produced an
    // active session the hourly settlement never processed -- no BTC credited,
    // ad cap and daily claim stuck for days. So for a new session a missing
    // start_time, or one from a previous local day, becomes now; a start
    // earlier TODAY is kept exactly as before (same-day restart). A missing
    // local_start_time is then derived from the start in the user's timezone.
    const startingNewSession = incomingMiningActive && (!existingRecord || !existingRecord.mining_isactive);
    if (startingNewSession) {
      const now = Date.now();
      const tz = updateData.timezone ?? existingRecord?.timezone ?? null;
      const off = updateData.offset ?? existingRecord?.offset;
      const chosen = Number(updateData.start_time ?? existingRecord?.start_time ?? 0);
      const usable = chosen > 0 && chosen <= now + 60 * 1000
        && getLocalDateStrAt(chosen, tz, off) === getLocalDateStrAt(now, tz, off);
      if (!usable) updateData.start_time = now;
      if (!updateData.local_start_time) {
        updateData.local_start_time = formatLocalStartTime(Number(updateData.start_time ?? chosen), tz, off);
      }
    }

    // DISABLED: Loss tracking initialization removed for new records
    // Loss tracking feature is no longer active

    const mining_details = await UserMiningDetail.findOneAndUpdate(
      { user: user_id },
      { $set: updateData, user: user_id },
      { new: true, upsert: true }
    );

    const effectiveHp = typeof mining_details.getEffectiveHashpower === 'function'
      ? mining_details.getEffectiveHashpower() : (mining_details.hashpower || 0);
    const streakBonus = typeof mining_details.getStreakBonusGh === 'function'
      ? mining_details.getStreakBonusGh() : 0;

    const responseDetails = {
      ...mining_details.toObject(),
      effective_hashpower: effectiveHp,
      streak_days: mining_details.streakDays ?? 0,
      streak_bonus_gh: streakBonus,
    };

    console.log("Setting User Data: ", updateData, user_id, "effective_hashpower:", effectiveHp);

    res.json({ success: true, mining_details: responseDetails, ad_cap_reached: adCapReached });
  } catch (err) {
    console.error("Error saving mining details:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Increment daily video count (called when user watches ad)
router.post('/increment-video', incrementDailyVideoCount);

// Increment loss offset ad count (called when user watches rewarded ad)
router.post('/increment-loss-ad', incrementLossOffsetAd);

// Get daily video progress
router.get('/daily-progress/:userId', getDailyProgress);

// ─── Trading History Routes ───

router.get('/trading-history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const mining = await UserMiningDetail.findOne({ user: userId });
    if (!mining) {
      return res.json({ success: true, history: [], stockGameBonus: 0 });
    }
    const history = (mining.tradingHistory || [])
      .sort((a, b) => b.earnedAt - a.earnedAt)
      .slice(0, 25);
    return res.json({
      success: true,
      history,
      stockGameBonus: mining.stockGameBonus || 0,
    });
  } catch (err) {
    console.error('Error fetching trading history:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/trading-history', async (req, res) => {
  try {
    const { user_id, trade } = req.body;
    if (!user_id || !trade) {
      return res.status(400).json({ success: false, message: 'user_id and trade are required' });
    }
    const mining = await UserMiningDetail.findOne({ user: user_id });
    if (!mining) {
      return res.status(404).json({ success: false, message: 'Mining details not found' });
    }
    mining.tradingHistory = mining.tradingHistory || [];
    mining.tradingHistory.unshift({
      tradeId: trade.tradeId || trade.id,
      earnedAt: trade.earnedAt,
      points: trade.points || 0,
      miningGh: trade.miningGh || 0,
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      direction: trade.direction,
      durationLabel: trade.durationLabel || '1 Min',
      won: trade.won,
      claimed: trade.claimed || false,
    });
    if (mining.tradingHistory.length > 50) {
      mining.tradingHistory = mining.tradingHistory.slice(0, 50);
    }
    await mining.save();
    return res.json({ success: true, history: mining.tradingHistory.slice(0, 25) });
  } catch (err) {
    console.error('Error saving trading history:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/trading-claim', async (req, res) => {
  try {
    const { user_id, tradeId } = req.body;
    if (!user_id || !tradeId) {
      return res.status(400).json({ success: false, message: 'user_id and tradeId are required' });
    }
    const mining = await UserMiningDetail.findOne({ user: user_id });
    if (!mining) {
      return res.status(404).json({ success: false, message: 'Mining details not found' });
    }
    const trade = (mining.tradingHistory || []).find(
      (t) => t.tradeId === tradeId
    );
    if (!trade) {
      return res.status(404).json({ success: false, message: 'Trade not found' });
    }
    if (trade.claimed) {
      return res.json({ success: true, message: 'Already claimed', stockGameBonus: mining.stockGameBonus || 0 });
    }
    trade.claimed = true;
    mining.markModified('tradingHistory');
    const reward = trade.miningGh || WIN_GH_REWARD_SERVER;
    mining.stockGameBonus = (mining.stockGameBonus || 0) + reward;
    await mining.save();
    return res.json({
      success: true,
      message: 'Reward claimed',
      stockGameBonus: mining.stockGameBonus,
      reward,
    });
  } catch (err) {
    console.error('Error claiming trading reward:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

const WIN_GH_REWARD_SERVER = 10;

router.get('/spin-history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const mining = await UserMiningDetail.findOne({ user: userId });
    if (!mining) {
      return res.json({ success: true, history: [] });
    }
    const history = (mining.spinHistory || [])
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 100);
    return res.json({ success: true, history });
  } catch (err) {
    console.error('Error fetching spin history:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/spin-history', async (req, res) => {
  try {
    const { user_id, item } = req.body;
    if (!user_id || !item?.spinId) {
      return res.status(400).json({ success: false, message: 'user_id and item.spinId are required' });
    }
    const mining = await UserMiningDetail.findOne({ user: user_id });
    if (!mining) {
      return res.status(404).json({ success: false, message: 'Mining details not found' });
    }

    mining.spinHistory = mining.spinHistory || [];
    const alreadyExists = mining.spinHistory.some((entry) => entry.spinId === item.spinId);
    if (!alreadyExists) {
      mining.spinHistory.unshift({
        spinId: item.spinId,
        ts: item.ts || Date.now(),
        sliceKey: item.sliceKey || 'unknown',
        label: item.label || 'Spin',
        gh: item.gh || 0,
        status: item.status || 'won_pending',
      });
      if (mining.spinHistory.length > 150) {
        mining.spinHistory = mining.spinHistory.slice(0, 150);
      }
      await mining.save();
    }

    return res.json({ success: true, history: mining.spinHistory.slice(0, 100) });
  } catch (err) {
    console.error('Error saving spin history:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/spin-history/claim', async (req, res) => {
  try {
    const { user_id, spinId } = req.body;
    if (!user_id || !spinId) {
      return res.status(400).json({ success: false, message: 'user_id and spinId are required' });
    }
    const mining = await UserMiningDetail.findOne({ user: user_id });
    if (!mining) {
      return res.status(404).json({ success: false, message: 'Mining details not found' });
    }
    const row = (mining.spinHistory || []).find((entry) => entry.spinId === spinId);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Spin history not found' });
    }
    row.status = 'claimed';
    mining.markModified('spinHistory');
    await mining.save();
    return res.json({ success: true });
  } catch (err) {
    console.error('Error claiming spin history:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/memory-history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const mining = await UserMiningDetail.findOne({ user: userId });
    if (!mining) {
      return res.json({ success: true, history: [] });
    }
    const history = (mining.memoryMatchHistory || [])
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 100);
    return res.json({ success: true, history });
  } catch (err) {
    console.error('Error fetching memory history:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/memory-history', async (req, res) => {
  try {
    const { user_id, item } = req.body;
    if (!user_id || !item?.gameId) {
      return res.status(400).json({ success: false, message: 'user_id and item.gameId are required' });
    }
    const mining = await UserMiningDetail.findOne({ user: user_id });
    if (!mining) {
      return res.status(404).json({ success: false, message: 'Mining details not found' });
    }

    mining.memoryMatchHistory = mining.memoryMatchHistory || [];
    const alreadyExists = mining.memoryMatchHistory.some((entry) => entry.gameId === item.gameId);
    if (!alreadyExists) {
      mining.memoryMatchHistory.unshift({
        gameId: item.gameId,
        ts: item.ts || Date.now(),
        durationSec: item.durationSec || 0,
        gh: item.gh || 0,
        won: !!item.won,
        status: item.status || (item.won ? 'won_pending' : 'lost'),
      });
      if (mining.memoryMatchHistory.length > 150) {
        mining.memoryMatchHistory = mining.memoryMatchHistory.slice(0, 150);
      }
      await mining.save();
    }

    return res.json({ success: true, history: mining.memoryMatchHistory.slice(0, 100) });
  } catch (err) {
    console.error('Error saving memory history:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/memory-history/claim', async (req, res) => {
  try {
    const { user_id, gameId } = req.body;
    if (!user_id || !gameId) {
      return res.status(400).json({ success: false, message: 'user_id and gameId are required' });
    }
    const mining = await UserMiningDetail.findOne({ user: user_id });
    if (!mining) {
      return res.status(404).json({ success: false, message: 'Mining details not found' });
    }
    const row = (mining.memoryMatchHistory || []).find((entry) => entry.gameId === gameId);
    if (!row) {
      return res.status(404).json({ success: false, message: 'Memory history not found' });
    }
    row.status = 'claimed';
    mining.markModified('memoryMatchHistory');
    await mining.save();
    return res.json({ success: true });
  } catch (err) {
    console.error('Error claiming memory history:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;