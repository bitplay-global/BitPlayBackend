import express from 'express';
import UserMiningDetail from "../../models/UserMiningDetails.js";
import DailyFreeMiner from "../../models/DailyMiner.js";
import { computeStreak, toDayString } from "../../helpers/streak.js";

const router = express.Router();

// POST endpoint to claim daily mining reward
router.post("/", async (req, res) => {
  try {
    const { userId, local_time } = req.body;
    if (!userId || !local_time) {
      return res.status(400).json({ success: false, message: "Missing userId or local_time." });
    }

    // Fetch user's mining details
    const miningDetails = await UserMiningDetail.findOne({ user: userId });
    if (!miningDetails || !miningDetails.mining_isactive) {
      return res.json({
        success: false,
        message: "Please activate mining before claiming reward",
        time_remaining: 0
      });
    }

    // Parse DD/MM/YYYY, hh:mm:ss AM/PM (format from formatMiningLocalTimeForApi)
    const dbParts = local_time.match(/\d+/g);
    const ampm = /AM|PM/i.exec(local_time)?.[0]?.toUpperCase();
    let hour = parseInt(dbParts[3], 10);
    if (ampm === "PM" && hour < 12) hour += 12;
    if (ampm === "AM" && hour === 12) hour = 0;
    const day = parseInt(dbParts[0], 10);
    const month = parseInt(dbParts[1], 10) - 1;
    const year = parseInt(dbParts[2], 10);
    const clientLocalTime = new Date(year, month, day, hour, parseInt(dbParts[4]), parseInt(dbParts[5]));

    const todayLocal = new Date(clientLocalTime.getFullYear(), clientLocalTime.getMonth(), clientLocalTime.getDate());

    const existingClaim = await DailyFreeMiner.findOne({
      userId
    });

    const nextLocalMidnight = new Date(clientLocalTime.getFullYear(), clientLocalTime.getMonth(), clientLocalTime.getDate() + 1);
    const time_remaining_secs = Math.max(0, Math.floor((nextLocalMidnight - clientLocalTime) / 1000));

    console.log("User Claimed DailyReward ?: ", existingClaim);
    console.log("Total Time Remaining: ", time_remaining_secs);

    if (existingClaim) {
        console.log("User Already Claimed Daily Reward", "UserID: ", userId);
      return res.json({
        success: true,
        message: "Reward already claimed",
        time_remaining: time_remaining_secs
      });
    }

    // Create new claim
    const claim = new DailyFreeMiner({ userId, claimedAt: clientLocalTime });
    await claim.save();

    // Update streak: consecutive days of claiming daily reward.
    // Day math lives in helpers/streak.js so this path and the mining POST
    // can never disagree about what counts as "yesterday".
    const todayStr = toDayString(clientLocalTime);
    if (miningDetails) {
      const next = computeStreak(miningDetails, todayStr);
      if (next.changed) {
        miningDetails.streakDays = next.streakDays;
        miningDetails.streakLastDate = next.streakLastDate;
        await miningDetails.save();
      }
      console.log("Streak:", next.reason, { userId, todayStr, streakDays: next.streakDays, streakLastDate: next.streakLastDate });
    }

    const streakBonusGh = typeof miningDetails.getStreakBonusGh === 'function'
      ? miningDetails.getStreakBonusGh() : 0;

    console.log("Reward claimed successfully", "UserID: ", userId, "Streak:", miningDetails.streakDays, "Bonus:", streakBonusGh);

    return res.json({
      success: true,
      message: "Reward claimed successfully",
      time_remaining: time_remaining_secs,
      streak_days: miningDetails.streakDays,
      streak_bonus_gh: streakBonusGh
    });

  } catch (err) {
    console.error("Error claiming daily reward:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
      time_remaining: 0
    });
  }
});

router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ success: false, message: "Missing userId." });
    }

    const existingClaim = await DailyFreeMiner.findOne({ userId });

    if (existingClaim) {
      return res.json({
        success: true,
        message: "Daily free miner claimed"
      });
    } else {
      return res.json({
        success: false,
        message: "Please claim the free miner first from HomeScreen"
      });
    }

  } catch (err) {
    console.error("Error checking daily free miner:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message
    });
  }
});

export default router;