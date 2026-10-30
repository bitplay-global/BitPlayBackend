import mongoose from "mongoose";
import BalanceHistory from "../models/BalanceHistory.js";
import ReferralRewardHistory from "../models/ReferralRewardHistory.js";
import { escapeRegex } from "../helpers/escapeRegex.js";
import { grantBonus } from "../helpers/bonusGrants.js";
import { BTC_PER_GH_PER_DAY } from "../helpers/miningDaySettlement.js";

// Referral reward percentage (default: 5%)
const REFERRAL_REWARD_PERCENTAGE = parseFloat(process.env.REFERRAL_REWARD_PERCENTAGE || "5.0");

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The referrer's reward for one of their referral's settled days: bonus mining
 * power for the next 24 hours, worth REFERRAL_REWARD_PERCENTAGE of what the
 * referral mined that day if the referrer mines through it.
 *
 * Until 2026-10-30 this was paid as BTC into BTC_DEPOSIT. App Store guideline
 * 3.1.5(v) bars crypto apps from paying currency for getting others to
 * download, so the reward is now mining power (models/BonusGrant.js, removed
 * again by the hourly cron when it expires). BTC already paid stays paid.
 */
export function referralRewardGh(childDailyMiningBtc) {
  const gh = (childDailyMiningBtc * (REFERRAL_REWARD_PERCENTAGE / 100)) / BTC_PER_GH_PER_DAY;
  return Math.round(gh * 100) / 100;
}

const dayKey = d => new Date(d).toISOString().slice(0, 10);

/**
 * Grants the bonus and records it. The bonus key and the history row are both
 * unique per (child, day), so a repeat never grants twice.
 * @returns {Promise<{rewardGh:number, granted:boolean}>}
 */
async function grantReferralReward({ parentUserId, childUserId, rewardDate, childDailyMining, now = new Date() }) {
  const rewardGh = referralRewardGh(childDailyMining);
  let granted = false;
  if (rewardGh > 0) {
    const r = await grantBonus({
      key: `referral:${childUserId}:${dayKey(rewardDate)}`,
      userId: parentUserId,
      hashpower: rewardGh,
      expiresAt: new Date(now.getTime() + DAY_MS),
      reason: `referral reward: ${REFERRAL_REWARD_PERCENTAGE}% of ${childUserId}'s mining on ${dayKey(rewardDate)}`,
      now,
    });
    granted = r === 'granted';
  }
  try {
    await ReferralRewardHistory.create({
      parentUserId,
      childUserId,
      rewardDate,
      childDailyMining: mongoose.Types.Decimal128.fromString(childDailyMining.toFixed(16)),
      rewardAmount: mongoose.Types.Decimal128.fromString("0"),
      rewardType: 'ghs',
      rewardGh,
      rewardPercentage: REFERRAL_REWARD_PERCENTAGE,
      status: 'processed'
    });
  } catch (err) {
    if (err?.code !== 11000) throw err; // already recorded
  }
  return { rewardGh, granted };
}

/**
 * Helper function to check if referralUsed value is valid (not null, 'null', or empty)
 * @param {string|null} referralUsed - The referralUsed value from user
 * @returns {boolean} - True if referralUsed is valid
 */
function isValidReferralUsed(referralUsed) {
  if (!referralUsed) return false;
  const trimmed = String(referralUsed).trim().toLowerCase();
  return trimmed !== '' && trimmed !== 'null';
}

/**
 * Get parent user ID from child's referralUsed field
 */
async function getParentUserId(childUserId, referralUsed) {
  try {
    // Skip if referralUsed is invalid
    if (!isValidReferralUsed(referralUsed)) {
      return null;
    }

    // Query users collection directly (case-insensitive match, consistent with /referrals endpoint)
    // escapeRegex: referralUsed is whatever the user typed at signup. Unescaped,
    // a stored value of `.*` matched an arbitrary user and paid them the reward.
    const usersCollection = mongoose.connection.collection("users");
    const parentUser = await usersCollection.findOne({
      referralCode: { $regex: `^${escapeRegex(referralUsed.trim())}$`, $options: "i" },
      isActive: true // Only match active users
    });

    if (!parentUser) {
      console.log(`[Referral Rewards] No parent found for child ${childUserId} with referralUsed: ${referralUsed}`);
      return null;
    }

    const parentUserId = parentUser._id.toString();

    // Never pay a user for referring themselves. Registration cannot produce
    // this (the code does not exist yet), but a later code change or a manual
    // edit to referralUsed could, and a self-referral is an uncapped 5%/day
    // credit on your own mining.
    if (parentUserId === String(childUserId)) {
      console.log(`[Referral Rewards] Ignoring self-referral for user ${childUserId}`);
      return null;
    }

    return parentUserId;
  } catch (error) {
    console.error(`[Referral Rewards] Error finding parent for child ${childUserId}:`, error);
    return null;
  }
}

/**
 * Calculate referral rewards for all BalanceHistory records that haven't been processed yet
 * This handles users across all timezones by processing each BalanceHistory record once
 * We only check records from the last 7 days to optimize performance
 */
async function calculateDailyReferralRewards() {
  try {
    // Only check BalanceHistory records from the last 7 days to optimize performance
    // Older records should have been processed already, but if not, they'll be caught on next run
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    
    const allBalanceHistoryRecords = await BalanceHistory.find({
      date: { $gte: sevenDaysAgo }
    }).lean();

    console.log(`[Referral Rewards] Found ${allBalanceHistoryRecords.length} total BalanceHistory records to check`);

    const rewards = [];
    const usersCollection = mongoose.connection.collection("users");

    for (const historyRecord of allBalanceHistoryRecords) {
      try {
        const childUserId = historyRecord.user;
        const historyDate = historyRecord.date;
        
        // Get child BTC mining amount (convert Decimal128 to number)
        const childDailyMining = parseFloat(historyRecord.balances?.BTC?.toString() || "0");

        // Skip if child didn't mine anything
        if (childDailyMining <= 0) {
          continue;
        }

        // Get child user's referralUsed value
        // Convert string user ID to ObjectId if valid, otherwise use as-is
        const childUserQuery = mongoose.Types.ObjectId.isValid(childUserId)
          ? { _id: new mongoose.Types.ObjectId(childUserId) }
          : { _id: childUserId };
        
        const childUser = await usersCollection.findOne(
          childUserQuery,
          { projection: { referralUsed: 1, isActive: 1 } }
        );

        if (!childUser) {
          console.log(`[Referral Rewards] Child user ${childUserId} not found`);
          continue;
        }

        // Skip inactive children (optional, aligned with /referrals endpoint)
        if (!childUser.isActive) {
          console.log(`[Referral Rewards] Skipping inactive child user ${childUserId}`);
          continue;
        }

        // Find parent user
        const parentUserId = await getParentUserId(childUserId, childUser.referralUsed);

        if (!parentUserId) {
          continue; // No valid parent, skip
        }

        // Check if reward already processed (duplicate prevention)
        const existingReward = await ReferralRewardHistory.findOne({
          parentUserId: parentUserId,
          childUserId: childUserId,
          rewardDate: historyDate
        });

        if (existingReward) {
          // Already processed, skip
          continue;
        }

        // Calculate reward (5% of child's daily mining)
        const rewardAmount = childDailyMining * (REFERRAL_REWARD_PERCENTAGE / 100);

        rewards.push({
          parentUserId,
          childUserId,
          rewardDate: historyDate,
          childDailyMining,
          rewardAmount,
          rewardPercentage: REFERRAL_REWARD_PERCENTAGE
        });

      } catch (error) {
        console.error(`[Referral Rewards] Error processing child ${historyRecord.user}:`, error);
        // Continue with next child instead of failing entire batch
      }
    }

    console.log(`[Referral Rewards] Calculated ${rewards.length} new referral rewards to process`);
    return rewards;
  } catch (error) {
    console.error("[Referral Rewards] Error calculating daily referral rewards:", error);
    throw error;
  }
}

/**
 * Process referral rewards for all unprocessed BalanceHistory records
 * - Checks for duplicate processing
 * - Gives the parent 24h of bonus mining power (grantReferralReward)
 * - Creates ReferralRewardHistory records
 * This handles users across all timezones by processing each record once
 */
async function processReferralRewards() {
  const startTime = Date.now();
  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let totalRewardAmount = 0;

  try {
    console.log(`[Referral Rewards] Starting reward processing for all unprocessed records`);

    // Calculate rewards for all unprocessed BalanceHistory records
    const rewards = await calculateDailyReferralRewards();

    // Process each reward
    for (const reward of rewards) {
      try {
        // Note: Duplicate check already done in calculateDailyReferralRewards,
        // but double-check here for safety
        const existingReward = await ReferralRewardHistory.findOne({
          parentUserId: reward.parentUserId,
          childUserId: reward.childUserId,
          rewardDate: reward.rewardDate
        });

        if (existingReward) {
          console.log(`[Referral Rewards] Reward already processed for parent ${reward.parentUserId}, child ${reward.childUserId}, date ${reward.rewardDate.toISOString().split('T')[0]}`);
          skippedCount++;
          continue;
        }

        const { rewardGh } = await grantReferralReward(reward);

        processedCount++;
        totalRewardAmount += rewardGh;

        console.log(`[Referral Rewards] Processed reward: parent ${reward.parentUserId} gets ${rewardGh} GH/s for 24h from child ${reward.childUserId}`);

      } catch (error) {
        console.error(`[Referral Rewards] Error processing reward for parent ${reward.parentUserId}, child ${reward.childUserId}:`, error);
        errorCount++;

        // Try to create a failed record for audit
        try {
          await ReferralRewardHistory.create({
            parentUserId: reward.parentUserId,
            childUserId: reward.childUserId,
            rewardDate: reward.rewardDate,
            childDailyMining: mongoose.Types.Decimal128.fromString(reward.childDailyMining.toFixed(8)),
            rewardAmount: mongoose.Types.Decimal128.fromString("0"),
            rewardType: 'ghs',
            rewardGh: referralRewardGh(reward.childDailyMining),
            rewardPercentage: reward.rewardPercentage,
            status: 'failed',
            notes: error.message
          });
        } catch (createError) {
          console.error(`[Referral Rewards] Failed to create failed reward record:`, createError);
        }
      }
    }

    const processingTime = ((Date.now() - startTime) / 1000).toFixed(2);

    const result = {
      success: true,
      processedCount,
      skippedCount,
      errorCount,
      totalRewardGh: totalRewardAmount.toFixed(2),
      processingTimeSeconds: processingTime
    };

    console.log(`[Referral Rewards] Processing completed in ${processingTime}s:`, result);

    return result;
  } catch (error) {
    console.error("[Referral Rewards] Error in processReferralRewards:", error);
    throw error;
  }
}

/**
 * Process referral reward for a single child user immediately after their mining reset
 * This is called when BalanceHistory is created (at user's local midnight)
 */
async function processReferralRewardForChild(childUserId, childDailyMining, rewardDate) {
  try {
    console.log(`[Referral Rewards] Processing reward for child ${childUserId}, mining: ${childDailyMining}, date: ${rewardDate}`);
    
    // Skip if child didn't mine anything
    if (!childDailyMining || childDailyMining <= 0) {
      console.log(`[Referral Rewards] Skipping child ${childUserId} - no mining amount (${childDailyMining})`);
      return null;
    }

    // Get child user's referralUsed value
    const usersCollection = mongoose.connection.collection("users");
    const childUserQuery = mongoose.Types.ObjectId.isValid(childUserId)
      ? { _id: new mongoose.Types.ObjectId(childUserId) }
      : { _id: childUserId };
    
    const childUser = await usersCollection.findOne(
      childUserQuery,
      { projection: { referralUsed: 1, isActive: 1 } }
    );

    if (!childUser) {
      console.log(`[Referral Rewards] ❌ Child user ${childUserId} not found`);
      return null;
    }

    console.log(`[Referral Rewards] Child user found: ${childUserId}, referralUsed: ${childUser.referralUsed}, isActive: ${childUser.isActive}`);

    // Skip inactive children
    if (!childUser.isActive) {
      console.log(`[Referral Rewards] ⏭️ Skipping inactive child user ${childUserId}`);
      return null;
    }

    // Find parent user
    console.log(`[Referral Rewards] Looking for parent with referralUsed: ${childUser.referralUsed}`);
    const parentUserId = await getParentUserId(childUserId, childUser.referralUsed);

    if (!parentUserId) {
      console.log(`[Referral Rewards] ⏭️ No valid parent found for child ${childUserId} with referralUsed: ${childUser.referralUsed}`);
      return null; // No valid parent
    }

    console.log(`[Referral Rewards] ✅ Found parent: ${parentUserId} for child ${childUserId}`);

    // Check if reward already processed (duplicate prevention)
    const existingReward = await ReferralRewardHistory.findOne({
      parentUserId: parentUserId,
      childUserId: childUserId,
      rewardDate: rewardDate
    });

    if (existingReward) {
      console.log(`[Referral Rewards] Reward already processed for parent ${parentUserId}, child ${childUserId}, date ${rewardDate.toISOString().split('T')[0]}`);
      return { alreadyProcessed: true };
    }

    const { rewardGh } = await grantReferralReward({ parentUserId, childUserId, rewardDate, childDailyMining });

    console.log(`[Referral Rewards] ✅ Processed reward: parent ${parentUserId} gets ${rewardGh} GH/s for 24h from child ${childUserId}`);

    return {
      success: true,
      parentUserId,
      childUserId,
      rewardGh,
      rewardDate
    };
  } catch (error) {
    console.error(`[Referral Rewards] Error processing reward for child ${childUserId}:`, error);
    
        // Try to create a failed record for audit
        try {
          const usersCollection = mongoose.connection.collection("users");
          const childUserQuery = mongoose.Types.ObjectId.isValid(childUserId)
            ? { _id: new mongoose.Types.ObjectId(childUserId) }
            : { _id: childUserId };
          
          const childUser = await usersCollection.findOne(childUserQuery, { projection: { referralUsed: 1 } });
          if (childUser) {
            const parentUserId = await getParentUserId(childUserId, childUser.referralUsed);
            if (parentUserId) {
              await ReferralRewardHistory.create({
                parentUserId: parentUserId,
                childUserId: childUserId,
                rewardDate: rewardDate,
                childDailyMining: mongoose.Types.Decimal128.fromString(childDailyMining.toFixed(16)),
                rewardAmount: mongoose.Types.Decimal128.fromString("0"),
                rewardType: 'ghs',
                rewardGh: referralRewardGh(childDailyMining),
                rewardPercentage: REFERRAL_REWARD_PERCENTAGE,
                status: 'failed',
                notes: error.message
              });
            }
          }
        } catch (createError) {
          console.error(`[Referral Rewards] Failed to create failed reward record:`, createError);
        }
    
    throw error;
  }
}

export {
  getParentUserId,
  calculateDailyReferralRewards,
  processReferralRewards,
  processReferralRewardForChild,
  REFERRAL_REWARD_PERCENTAGE
};
