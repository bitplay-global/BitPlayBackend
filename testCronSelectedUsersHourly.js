import mongoose from "mongoose";
import Balance from "./models/Balance.js";
import BalanceHistory from "./models/BalanceHistory.js";
import UserMiningDetail from "./models/UserMiningDetails.js";
import DailyFreeMiner from "./models/DailyMiner.js";
import { sendMiningStoppedNotification } from "./services/notificationService.js";
import { initializeFirebase } from "./config/firebase.js";
import { processReferralRewardForChild } from "./services/referralRewardService.js";
import {
  getUserLocalDateStr,
  getSessionStartDateStrFromLocalStart,
  getHistoryDateFromSessionStartStr,
  computeMinedBtcOnDayRollover,
} from "./helpers/miningDaySettlement.js";

initializeFirebase();

const MONGO_URI = process.env.MONGODB_URI;

// Put only the users you want to test here.
const SELECTED_USER_IDS = [
  "6984281ef7ae9d1d478c5b6f", // harshgami27
  "69e0afcb9b714a692c5724fc", // harshtest1
  "69e0b33a9b714a692c572508", // harshtest2
  "69906c8ef7ae9d1d478c6b6b",  // trayani75
  "69f974ca88ca0fdc966e23a4", //suraj
];

async function connectDB() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(MONGO_URI);
  }
}

console.log("[TEST CRON SELECTED] Started");
console.log(`[TEST CRON SELECTED] Runs immediately once. Selected users: ${SELECTED_USER_IDS.length}`);

/**
 * Mirrors cronJobs.js hourly settlement ("0 * * * *") but only for SELECTED_USER_IDS.
 */
async function runSelectedUsersSettlementOnce() {
  console.log("[TEST CRON SELECTED] Running immediate timezone-aware settlement check (cron parity)...");

  try {
    await connectDB();

    if (!SELECTED_USER_IDS.length) {
      console.log("[TEST CRON SELECTED] No selected users configured. Skipping.");
      return;
    }

    const activeMiners = await UserMiningDetail.find({
      user: { $in: SELECTED_USER_IDS },
      mining_isactive: true,
      local_start_time: { $exists: true, $nin: [null, ""] },
      start_time: { $gt: 0 },
    });

    console.log(`[TEST CRON SELECTED] Found ${activeMiners.length} active selected users to check`);

    let processedCount = 0;

    for (const miningDetail of activeMiners) {
      try {
        const userId = miningDetail.user;
        const userTz = miningDetail.timezone || null;
        const userOffset = miningDetail.offset;

        const userTodayStr = getUserLocalDateStr(userTz, userOffset);
        const sessionStartDateStr = getSessionStartDateStrFromLocalStart(miningDetail.local_start_time);

        if (!sessionStartDateStr) {
          console.warn(
            `[TEST CRON SELECTED] User ${userId}: could not parse local_start_time, skipping cron settlement`
          );
          continue;
        }

        // Same local calendar day as when mining started → do nothing (wait until after midnight).
        // if (userTodayStr <= sessionStartDateStr) {
        //   continue;
        // }

        const userBalance = await Balance.findOne({ user: userId });
        if (!userBalance) continue;

        const syncedBtc = parseFloat(userBalance?.BTC?.toString() || "0");
        const fromElapsed = computeMinedBtcOnDayRollover({ miningDetail, userTz, userOffset });

        console.log("syncedBtc:", syncedBtc, "fromElapsed:", fromElapsed);

        const minedBtc = Math.max(0, Math.min(syncedBtc, fromElapsed));
        console.log(
          `[TEST CRON SELECTED] User ${userId} (tz=${userTz || "offset=" + userOffset}): sessionDay=${sessionStartDateStr}, today=${userTodayStr}, synced=${syncedBtc}, fromElapsed=${fromElapsed}, mined(min)=${minedBtc}`
        );

        const historyDate = getHistoryDateFromSessionStartStr(sessionStartDateStr);

        if (minedBtc > 0) {
          userBalance.BTC_DEPOSIT = parseFloat(userBalance.BTC_DEPOSIT?.toString() || "0") + minedBtc;
          userBalance.BTC = 0;
          await userBalance.save();

          // await BalanceHistory.findOneAndUpdate(
          //   { user: userId, date: historyDate },
          //   {
          //     $set: {
          //       user: userId,
          //       firebase_uid: userBalance.firebase_uid || undefined,
          //       date: historyDate,
          //       balances: {
          //         BTC: minedBtc,
          //       },
          //     },
          //   },
          //   { upsert: true, new: true }
          // );

          console.log(
            `[TEST CRON SELECTED] ✅ Saved mined BTC history for user ${userId}: ${minedBtc} (date=${sessionStartDateStr})`
          );
        } else {
          userBalance.BTC = 0;
          await userBalance.save();
        }

        try {
          console.log(
            `[TEST CRON SELECTED] [Referral Rewards] 🔄 Processing referral reward for child ${userId}, BTC: ${minedBtc}, date: ${historyDate.toISOString()}`
          );
          processReferralRewardForChild(userId, minedBtc, historyDate)
            .then((result) => {
              if (result && !result.alreadyProcessed) {
                console.log(
                  `[TEST CRON SELECTED] [Referral Rewards] ✅ Successfully processed referral reward for child ${userId}:`,
                  result
                );
              } else if (result && result.alreadyProcessed) {
                console.log(`[TEST CRON SELECTED] [Referral Rewards] ⏭️ Reward already processed for child ${userId}`);
              } else {
                console.log(
                  `[TEST CRON SELECTED] [Referral Rewards] ℹ️ No reward to process for child ${userId} (no parent or no mining)`
                );
              }
            })
            .catch((err) => {
              console.error(
                `[TEST CRON SELECTED] [Referral Rewards] ❌ Error processing referral reward for child ${userId}:`,
                err
              );
            });
        } catch (refErr) {
          console.error(
            `[TEST CRON SELECTED] [Referral Rewards] ❌ Sync error scheduling referral reward for child ${userId}:`,
            refErr
          );
        }

        const now = new Date();
        const purchasedHashpower = miningDetail.purchasedHashpower || 0;

        await UserMiningDetail.findOneAndUpdate(
          { user: userId },
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
              lastResetTime: now,
              stockGameBonus: 0,
            },
          }
        );

        await DailyFreeMiner.deleteMany({ userId });

        try {
          await sendMiningStoppedNotification(userId);
        } catch (notifyErr) {
          console.error(`[TEST CRON SELECTED] Error sending mining stopped notification to user ${userId}:`, notifyErr);
        }

        processedCount++;
        console.log(
          `[TEST CRON SELECTED] Reset user ${userId}: claimed=0, purchased=${purchasedHashpower}, total=${purchasedHashpower}, resetTime=${now.toISOString()}, userDate=${userTodayStr}`
        );
      } catch (userErr) {
        console.error(`[TEST CRON SELECTED] Error processing user ${miningDetail.user}:`, userErr);
      }
    }

    console.log(`[TEST CRON SELECTED] Completed. Processed ${processedCount} selected users (day rollover).`);
  } catch (err) {
    console.error("[TEST CRON SELECTED] Error:", err);
  }
}

runSelectedUsersSettlementOnce()
  .then(() => {
    console.log("[TEST CRON SELECTED] Finished immediate run.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[TEST CRON SELECTED] Fatal error:", err);
    process.exit(1);
  });
