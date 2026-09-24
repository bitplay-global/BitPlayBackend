import cron from "node-cron";
import mongoose from "mongoose";
import Balance from "./models/Balance.js";
import BalanceHistory from "./models/BalanceHistory.js";
import UserMiningDetail from "./models/UserMiningDetails.js";
import DailyFreeMiner from "./models/DailyMiner.js";
import {
  sendMiningStoppedNotification,
} from "./services/notificationService.js";
import { initializeFirebase } from "./config/firebase.js";

initializeFirebase();

const MONGO_URI = process.env.MONGODB_URI;

const BTC_PER_HASHPOWER_PER_SEC = 0.0000000000000070;

// ========================================================================
// CONFIG — set your test user ID and mining duration here
// ========================================================================
const TEST_USER_ID = "69766791007d1dad20481a53";
const TEST_MINING_DURATION_MS = 30 * 60 * 1000; // 30 minutes
// ========================================================================

console.log(`[TEST CRON] Started! User: ${TEST_USER_ID}, Duration: ${TEST_MINING_DURATION_MS / 60000} min`);
console.log(`[TEST CRON] Checking every minute...`);

async function connectDB() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(MONGO_URI);
    console.log("[TEST CRON] Connected to MongoDB");
  }
}

cron.schedule("* * * * *", async () => {
  try {
    await connectDB();

    const miningDetail = await UserMiningDetail.findOne({ user: TEST_USER_ID });
    if (!miningDetail) {
      console.log(`[TEST CRON] User ${TEST_USER_ID} not found, skipping`);
      return;
    }
    if (!miningDetail.mining_isactive || !miningDetail.start_time || !miningDetail.hashpower || miningDetail.hashpower <= 0) {
      console.log(`[TEST CRON] Mining not active for ${TEST_USER_ID}, waiting...`);
      return;
    }

    const startMs = Number(miningDetail.start_time);
    const elapsedMs = Date.now() - startMs;

    if (elapsedMs < TEST_MINING_DURATION_MS) {
      const remaining = Math.round((TEST_MINING_DURATION_MS - elapsedMs) / 1000);
      console.log(`[TEST CRON] ${remaining}s remaining in 30-min cycle`);
      return;
    }

    console.log(`[TEST CRON] ⏱ 30-minute cycle complete!`);

    const userBalance = await Balance.findOne({ user: TEST_USER_ID });
    if (!userBalance) {
      console.log(`[TEST CRON] No balance record found, skipping`);
      return;
    }

    const syncedBtc = parseFloat(userBalance?.BTC?.toString() || '0');

    const effectiveHp = typeof miningDetail.getEffectiveHashpower === 'function'
      ? miningDetail.getEffectiveHashpower()
      : (miningDetail.hashpower || 0);
    const stockBonus = miningDetail.stockGameBonus || 0;
    const totalPower = effectiveHp + stockBonus;

    const elapsedSec = elapsedMs / 1000;
    const miningDurationSec = Math.min(elapsedSec, TEST_MINING_DURATION_MS / 1000);
    const fromElapsed = totalPower * BTC_PER_HASHPOWER_PER_SEC * miningDurationSec;

    const minedBtc = Math.max(syncedBtc, fromElapsed);
    console.log(`[TEST CRON] syncedBtc=${syncedBtc}, fromElapsed=${fromElapsed}, minedBtc=${minedBtc}, totalPower=${totalPower}`);

    if (minedBtc > 0) {
      userBalance.BTC_DEPOSIT = parseFloat(userBalance.BTC_DEPOSIT?.toString() || "0") + minedBtc;
      userBalance.BTC = 0;
      await userBalance.save();
      console.log(`[TEST CRON] Balance updated: BTC_DEPOSIT += ${minedBtc}, BTC = 0`);

      const historyDate = new Date();

      await BalanceHistory.findOneAndUpdate(
        { user: TEST_USER_ID, date: historyDate },
        {
          $set: {
            user: TEST_USER_ID,
            firebase_uid: userBalance.firebase_uid || undefined,
            date: historyDate,
            balances: { BTC: minedBtc },
          },
        },
        { upsert: true, new: true }
      );

      console.log(`[TEST CRON] ✅ History saved: ${minedBtc} BTC at ${historyDate.toISOString()}`);
    }

    // Reset mining — same flow as the daily midnight reset
    const purchasedHashpower = miningDetail.purchasedHashpower || 0;

    await UserMiningDetail.findOneAndUpdate(
      { user: TEST_USER_ID },
      {
        $set: {
          claimedHashpower: 0,
          hashpower: purchasedHashpower,
          mining_isactive: false,
          rewarded_ads_watched: 0,
          thirty_gh_rewarded_ads_watched: 0,
          random_ads_watched: 0,
          start_time: 0,
          stop_time: 0,
          local_start_time: null,
          local_stop_time: null,
          lastResetTime: new Date(),
          stockGameBonus: 0,
        },
      }
    );

    await DailyFreeMiner.deleteMany({ userId: TEST_USER_ID });

    try {
      await sendMiningStoppedNotification(TEST_USER_ID);
    } catch (notifyErr) {
      console.error(`[TEST CRON] Error sending notification:`, notifyErr);
    }

    console.log(`[TEST CRON] ✅ Reset complete. Purchased HP=${purchasedHashpower}. Re-activate mining to start next cycle.`);

  } catch (err) {
    console.error("[TEST CRON] Error:", err);
  }
});
