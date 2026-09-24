import cron from "node-cron";
import mongoose from "mongoose";
import Balance from "./models/Balance.js";
import BalanceHistory from "./models/BalanceHistory.js";
import DailyRewardClaim from "./models/DailyRewardClaim.js";
import DailyRewardClaimHistory from "./models/DailyRewardClaimHistory.js";
import UserMiningDetail from "./models/UserMiningDetails.js";
import DailyFreeMiner from "./models/DailyMiner.js";
import MiningSession from "./models/MiningSession.js";
import StuckSessionRecovery from "./models/StuckSessionRecovery.js";
import {
  sendMiningExpiryNotification,
  sendClockResetNotification,
  sendVideoReminderNotification,
  sendDailyRewardReminder,
  sendMiningStoppedNotification,
} from "./services/notificationService.js";
import { initializeFirebase } from "./config/firebase.js";
import { processReferralRewardForChild } from "./services/referralRewardService.js";
import {
  getUserLocalDateStr,
  getSessionStartDateStrFromLocalStart,
  resolveSessionStartDateStr,
  getHistoryDateFromSessionStartStr,
  computeMinedBtcOnDayRollover,
} from "./helpers/miningDaySettlement.js";

console.log("Cron Job Started!!");

// Initialize Firebase Admin SDK for push notifications
initializeFirebase();

const MONGO_URI = process.env.MONGODB_URI;

const ensureMongoConnected = async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(MONGO_URI);
  }
};

// Runs every hour. Only for ACTIVE miners: if the user's local calendar day is AFTER
// the session start day, settle BTC and deactivate (local midnight crossed).
// IMPORTANT: Do not use lastResetTime alone — new sessions have lastResetTime null and
//            would incorrectly reset every hour before this fix.
//
// SECURITY: This cron is the ONLY path that creates BalanceHistory records and
// credits Balance.BTC_DEPOSIT for mining rewards. The user-mining GET endpoint
// no longer settles. The mined amount written to history is the conservative
// MIN of the client-synced Balance.BTC value and the server-computed
// `fromElapsed` value (capped at user-local midnight); this prevents a client
// from inflating its daily settlement by pushing oversized values into
// Balance.BTC via SET_WALLET_BALANCE.
cron.schedule("0 * * * *", async () => {
  console.log("Running hourly timezone-aware daily settlement check (active miners, day rollover only)...");

  try {
    await ensureMongoConnected();

    // local_start_time is NOT required: a session activated without it (the app
    // still holding the previous day's start after midnight) was skipped here
    // forever -- never settled or reset, leaving the ad cap and daily claim
    // stuck for days. resolveSessionStartDateStr falls back to start_time.
    const activeMiners = await UserMiningDetail.find({
      mining_isactive: true,
      start_time: { $gt: 0 },
    });

    console.log(`Checking ${activeMiners.length} active mining sessions for local day rollover...`);

    let processedCount = 0;

    for (const miningDetail of activeMiners) {
      try {
        const userId = miningDetail.user;
        const userTz = miningDetail.timezone || null;
        const userOffset = miningDetail.offset;

        const userTodayStr = getUserLocalDateStr(userTz, userOffset);
        const sessionStartDateStr = resolveSessionStartDateStr(miningDetail);

        if (!sessionStartDateStr) {
          console.warn(`User ${userId}: no usable local_start_time or start_time, skipping cron settlement`);
          continue;
        }
        if (!getSessionStartDateStrFromLocalStart(miningDetail.local_start_time)) {
          console.log(`User ${userId}: session has no local_start_time; using start_time's local day ${sessionStartDateStr}`);
        }

        // Same local calendar day as when mining started → do nothing (wait until after midnight).
        if (userTodayStr <= sessionStartDateStr) {
          continue;
        }

        // A session stuck without local_start_time is about to be reset, which
        // wipes its hashpower. Keep what it was, so the missed days can be
        // compensated (scripts/compensate-stuck-sessions.js). Never blocks
        // the settlement itself.
        if (!getSessionStartDateStrFromLocalStart(miningDetail.local_start_time)) {
          try {
            await StuckSessionRecovery.updateOne(
              { user: String(userId), startTime: Number(miningDetail.start_time) },
              {
                $setOnInsert: {
                  sessionDay: sessionStartDateStr,
                  timezone: userTz,
                  offset: Number.isFinite(Number(userOffset)) ? Number(userOffset) : null,
                  hashpower: Number(miningDetail.hashpower) || 0,
                  source: 'settlement',
                },
                $set: { settledAt: new Date(), settledDay: userTodayStr },
              },
              { upsert: true },
            );
          } catch (recErr) {
            console.error(`User ${userId}: could not record stuck session for compensation:`, recErr.message);
          }
        }

        const userBalance = await Balance.findOne({ user: userId });
        if (!userBalance) continue;

        const syncedBtc = parseFloat(userBalance?.BTC?.toString() || '0');
        const fromElapsed = computeMinedBtcOnDayRollover({ miningDetail, userTz, userOffset });
        // Take the conservative MIN of (client-synced BTC, server-computed BTC).
        // - syncedBtc may be inflated by a tampered client.
        // - fromElapsed is capped at the user's local midnight by computeMinedBtcOnDayRollover.
        // Using MIN guarantees the credited amount can never exceed what the
        // server itself can verify for that user's mining session.
        const minedBtc = Math.max(0, Math.min(syncedBtc, fromElapsed));
        console.log(`User ${userId} (tz=${userTz || 'offset=' + userOffset}): sessionDay=${sessionStartDateStr}, today=${userTodayStr}, synced=${syncedBtc}, fromElapsed=${fromElapsed}, mined(min)=${minedBtc}`);

        const historyDate = getHistoryDateFromSessionStartStr(sessionStartDateStr);

        if (minedBtc > 0) {
          userBalance.BTC_DEPOSIT = parseFloat(userBalance.BTC_DEPOSIT?.toString() || "0") + minedBtc;
          userBalance.BTC = 0;
          await userBalance.save();

          await BalanceHistory.findOneAndUpdate(
            { user: userId, date: historyDate },
            {
              $set: {
                user: userId,
                firebase_uid: userBalance.firebase_uid || undefined,
                date: historyDate,
                balances: {
                  BTC: minedBtc,
                },
              },
            },
            { upsert: true, new: true }
          );

          console.log(`✅ Saved mined BTC history for user ${userId}: ${minedBtc} (date=${sessionStartDateStr})`);
        } else {
          // Still reset session even if nothing was mined (e.g. zero hashpower).
          // BTC field is reset to 0 below via the user-mining update.
          userBalance.BTC = 0;
          await userBalance.save();
        }

        // Process referral reward for this child user (5% of daily mining to parent).
        // Fire-and-forget so a slow/failed referral run doesn't block other users.
        try {
          console.log(`[Referral Rewards] 🔄 Processing referral reward for child ${userId}, BTC: ${minedBtc}, date: ${historyDate.toISOString()}`);
          processReferralRewardForChild(userId, minedBtc, historyDate)
            .then((result) => {
              if (result && !result.alreadyProcessed) {
                console.log(`[Referral Rewards] ✅ Successfully processed referral reward for child ${userId}:`, result);
              } else if (result && result.alreadyProcessed) {
                console.log(`[Referral Rewards] ⏭️ Reward already processed for child ${userId}`);
              } else {
                console.log(`[Referral Rewards] ℹ️ No reward to process for child ${userId} (no parent or no mining)`);
              }
            })
            .catch((err) => {
              console.error(`[Referral Rewards] ❌ Error processing referral reward for child ${userId}:`, err);
            });
        } catch (refErr) {
          console.error(`[Referral Rewards] ❌ Sync error scheduling referral reward for child ${userId}:`, refErr);
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
          console.error(`Error sending mining stopped notification to user ${userId}:`, notifyErr);
        }

        processedCount++;
        console.log(`Reset user ${userId}: claimed=0, purchased=${purchasedHashpower}, total=${purchasedHashpower}, resetTime=${now.toISOString()}, userDate=${userTodayStr}`);

      } catch (userErr) {
        console.error(`Error processing user ${miningDetail.user}:`, userErr);
      }
    }

    console.log(`Hourly settlement check completed. Processed ${processedCount} users (day rollover).`);

  } catch (err) {
    console.error("Error in hourly settlement cron job:", err);
  }
});

// Check for expired mining sessions every 30 minutes
cron.schedule("*/30 * * * *", async () => {
  console.log("🔔 Checking for expired mining sessions...");

  try {
    await ensureMongoConnected();

    // Find sessions that have expired but not notified
    const expiredSessions = await MiningSession.findExpiredNotNotified();

    console.log(`Found ${expiredSessions.length} expired sessions to notify`);

    for (const session of expiredSessions) {
      try {
        // Send expiry notification
        await sendMiningExpiryNotification(session.user_id);

        // Mark as notified
        await session.recordNotification('expired');

        console.log(`✅ Sent expiry notification to user ${session.user_id}`);
      } catch (notifyErr) {
        console.error(`Error notifying user ${session.user_id}:`, notifyErr);
      }
    }

    console.log("Expired mining session notifications completed");

  } catch (err) {
    console.error("Error in expired mining session cron job:", err);
  }
});

/**
 * Check for mining sessions expiring soon every hour
 *
 */
cron.schedule("0 * * * *", async () => {
  console.log("⏰ Checking for mining sessions expiring soon...");

  try {
    await ensureMongoConnected();

    // Find sessions expiring within 1 hour
    const expiringSessions = await MiningSession.findExpiringSoon();

    console.log(`Found ${expiringSessions.length} sessions expiring soon`);

    for (const session of expiringSessions) {
      try {
        // Calculate hours remaining
        const hoursRemaining = Math.ceil(
          (session.end_time - new Date()) / (1000 * 60 * 60)
        );

        // Send warning notification
        await sendClockResetNotification(session.user_id, hoursRemaining);

        // Mark as notified
        await session.recordNotification('expiry_warning');

        console.log(`✅ Sent expiry warning to user ${session.user_id} (${hoursRemaining}h remaining)`);
      } catch (notifyErr) {
        console.error(`Error notifying user ${session.user_id}:`, notifyErr);
      }
    }

    console.log("Expiry warning notifications completed");

  } catch (err) {
    console.error("Error in expiry warning cron job:", err);
  }
});

/**
 * Send video reminders every 6 hours (4 times a day)

 */
cron.schedule("0 */6 * * *", async () => {
  console.log("🎥 Checking for video reminder opportunities...");

  try {
    await ensureMongoConnected();

    // Find active sessions with low video count
    const sessionsNeedingReminder = await MiningSession.findNeedingVideoReminder();

    console.log(`Found ${sessionsNeedingReminder.length} users needing video reminders`);

    for (const session of sessionsNeedingReminder) {
      try {
        const maxAds = 10; // From frontend MAX_ADS constant

        // Send video reminder
        await sendVideoReminderNotification(
          session.user_id,
          session.ads_watched,
          maxAds
        );

        // Record that reminder was sent
        await session.recordNotification('video_reminder');

        console.log(`✅ Sent video reminder to user ${session.user_id} (${session.ads_watched}/${maxAds} ads)`);
      } catch (notifyErr) {
        console.error(`Error sending video reminder to user ${session.user_id}:`, notifyErr);
      }
    }

    console.log("Video reminder notifications completed");

  } catch (err) {
    console.error("Error in video reminder cron job:", err);
  }
});

/**
 * Send daily reward reminders at 9 AM server time
 *
 */
// cron.schedule("0 9 * * *", async () => {
//   console.log("🎁 Sending daily reward reminders...");

//   try {
//     await mongoose.connect(MONGO_URI);

//     // Find users who haven't claimed daily reward yet
//     const today = new Date();
//     today.setHours(0, 0, 0, 0);

//     const unclaimedUsers = await DailyFreeMiner.distinct('userId', {
//       createdAt: { $lt: today }
//     });

//     // Get all users with mining details
//     const allUsers = await UserMiningDetail.find({}, 'user');

//     // Filter users who haven't claimed today
//     const usersToNotify = allUsers
//       .map(u => u.user)
//       .filter(userId => !unclaimedUsers.includes(userId));

//     console.log(`Sending daily reward reminders to ${usersToNotify.length} users`);

//     // for (const userId of usersToNotify) {
//     //   try {
//     //     await sendDailyRewardReminder(userId);
//     //     console.log(`✅ Sent daily reward reminder to user ${userId}`);
//     //   } catch (notifyErr) {
//     //     console.error(`Error sending reward reminder to user ${userId}:`, notifyErr);
//     //   }
//     // }

//     console.log("Daily reward reminders completed");

//   } catch (err) {
//     console.error("Error in daily reward reminder cron job:", err);
//   }
// });