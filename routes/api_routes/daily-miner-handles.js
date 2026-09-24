import express from 'express';
import UserMiningDetail from "../../models/UserMiningDetails.js";
import DailyFreeMiner from "../../models/DailyMiner.js";

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

    // Update streak: consecutive days of claiming daily reward
    const yyyy = clientLocalTime.getFullYear();
    const mm = String(clientLocalTime.getMonth() + 1).padStart(2, "0");
    const dd = String(clientLocalTime.getDate()).padStart(2, "0");
    const todayStr = `${yyyy}-${mm}-${dd}`;
    const yesterday = new Date(clientLocalTime);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;

    // Update streak: consecutive days of claiming daily reward
    if (miningDetails) {
      const last = (miningDetails.streakLastDate && String(miningDetails.streakLastDate).trim()) || "";
      const prevDays = miningDetails.streakDays || 0;
      if (last === todayStr) {
        console.log("Streak: already counted today", { userId, todayStr, streakDays: prevDays });
      } else if (last === yesterdayStr) {
        miningDetails.streakDays = prevDays + 1;
        miningDetails.streakLastDate = todayStr;
        await miningDetails.save();
        console.log("Streak: incremented (consecutive)", { userId, todayStr, yesterdayStr, from: prevDays, to: miningDetails.streakDays });
      } else {
        miningDetails.streakDays = 1;
        miningDetails.streakLastDate = todayStr;
        await miningDetails.save();
        console.log("Streak: reset/start", { userId, todayStr, last: last || "none", streakDays: 1 });
      }
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