import mongoose from "mongoose";
import Balance from "../models/Balance.js";
import BalanceHistory from "../models/BalanceHistory.js";
import ReferralRewardHistory from "../models/ReferralRewardHistory.js";
import { escapeRegex } from "../helpers/escapeRegex.js";

// Referral reward percentage (default: 5%)
const REFERRAL_REWARD_PERCENTAGE = parseFloat(process.env.REFERRAL_REWARD_PERCENTAGE || "5.0");

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
 * - Updates parent's BTC_DEPOSIT balance
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

        // Get parent's balance
        const parentBalance = await Balance.findOne({ user: reward.parentUserId });

        if (!parentBalance) {
          console.error(`[Referral Rewards] Parent balance not found for user ${reward.parentUserId}`);
          errorCount++;
          continue;
        }

        // Convert reward amount to Decimal128 format
        // 16 dp, matching processReferralRewardForChild. At 8 dp this path
        // silently truncated small rewards to zero, so the same reward was worth
        // a different amount depending on which path happened to credit it.
        const rewardAmountDecimal = mongoose.Types.Decimal128.fromString(reward.rewardAmount.toFixed(16));
        const childDailyMiningDecimal = mongoose.Types.Decimal128.fromString(reward.childDailyMining.toFixed(16));

        // Update parent's BTC_DEPOSIT balance
        const currentBTC_DEPOSIT = parseFloat(parentBalance.BTC_DEPOSIT?.toString() || "0");
        const newBTC_DEPOSIT = currentBTC_DEPOSIT + reward.rewardAmount;
        parentBalance.BTC_DEPOSIT = mongoose.Types.Decimal128.fromString(newBTC_DEPOSIT.toFixed(16));
        await parentBalance.save();

        // Create ReferralRewardHistory record
        // Use the exact date from BalanceHistory (user's local timezone date)
        await ReferralRewardHistory.create({
          parentUserId: reward.parentUserId,
          childUserId: reward.childUserId,
          rewardDate: reward.rewardDate,
          childDailyMining: childDailyMiningDecimal,
          rewardAmount: rewardAmountDecimal,
          rewardPercentage: reward.rewardPercentage,
          status: 'processed'
        });

        processedCount++;
        totalRewardAmount += reward.rewardAmount;

        console.log(`[Referral Rewards] Processed reward: parent ${reward.parentUserId} received ${reward.rewardAmount.toFixed(8)} BTC from child ${reward.childUserId}`);

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
            rewardAmount: mongoose.Types.Decimal128.fromString(reward.rewardAmount.toFixed(8)),
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
      totalRewardAmount: totalRewardAmount.toFixed(8),
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

    // Calculate reward (5% of child's daily mining)
    const rewardAmount = childDailyMining * (REFERRAL_REWARD_PERCENTAGE / 100);

    console.log(`[Referral Rewards] Calculated reward: ${rewardAmount} BTC (5% of ${childDailyMining} BTC)`);

    // Get parent's balance
    const parentBalance = await Balance.findOne({ user: parentUserId });

    if (!parentBalance) {
      console.error(`[Referral Rewards] Parent balance not found for user ${parentUserId}`);
      throw new Error(`Parent balance not found for user ${parentUserId}`);
    }

    // Convert reward amount to Decimal128 format
    // Use more precision (16 decimal places) to handle very small amounts
    // BTC can have up to 8 decimal places, but we store with more precision internally
    const rewardAmountDecimal = mongoose.Types.Decimal128.fromString(rewardAmount.toFixed(16));
    const childDailyMiningDecimal = mongoose.Types.Decimal128.fromString(childDailyMining.toFixed(16));

    // Update parent's BTC_DEPOSIT balance
    const currentBTC_DEPOSIT = parseFloat(parentBalance.BTC_DEPOSIT?.toString() || "0");
    const newBTC_DEPOSIT = currentBTC_DEPOSIT + rewardAmount;
    // Store with 16 decimal places internally, but it will be displayed with 8 decimal places in the UI
    parentBalance.BTC_DEPOSIT = mongoose.Types.Decimal128.fromString(newBTC_DEPOSIT.toFixed(16));
    await parentBalance.save();
    
    console.log(`[Referral Rewards] Updated parent balance: ${currentBTC_DEPOSIT} → ${newBTC_DEPOSIT} BTC (+${rewardAmount} BTC)`);

    // Create ReferralRewardHistory record
    await ReferralRewardHistory.create({
      parentUserId: parentUserId,
      childUserId: childUserId,
      rewardDate: rewardDate,
      childDailyMining: childDailyMiningDecimal,
      rewardAmount: rewardAmountDecimal,
      rewardPercentage: REFERRAL_REWARD_PERCENTAGE,
      status: 'processed'
    });

    console.log(`[Referral Rewards] ✅ Processed reward: parent ${parentUserId} received ${rewardAmount} BTC (${rewardAmount.toFixed(8)} BTC rounded) from child ${childUserId}`);

    return {
      success: true,
      parentUserId,
      childUserId,
      rewardAmount,
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
              const failedRewardAmount = childDailyMining * (REFERRAL_REWARD_PERCENTAGE / 100);
              await ReferralRewardHistory.create({
                parentUserId: parentUserId,
                childUserId: childUserId,
                rewardDate: rewardDate,
                childDailyMining: mongoose.Types.Decimal128.fromString(childDailyMining.toFixed(16)),
                rewardAmount: mongoose.Types.Decimal128.fromString(failedRewardAmount.toFixed(16)),
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
