import mongoose from "mongoose";
import Balance from "../models/Balance.js";
import BalanceHistory from "../models/BalanceHistory.js";
import DailyRewardClaim from "../models/DailyRewardClaim.js";
import DailyRewardClaimHistory from "../models/DailyRewardClaimHistory.js";
import UserMiningDetail from "../models/UserMiningDetails.js";

const MONGO_URI = process.env.MONGODB_URI;

const BTC_PER_HASHPOWER_PER_SEC = 0.000000000001;
const MAX_MINING_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

try {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB");

  const today = new Date().setHours(0, 0, 0, 0);
  console.log("Fetching user balances...");

  const allBalances = await Balance.find({});

  for (const bal of allBalances) {
    try {
        // --- Log user being processed ---
        console.log(`Processing user balance: ${bal.user}`);

        // Fetch user’s mining details
        const mining_details = await UserMiningDetail.findOne({ user: bal.user });
        let accumulatedBTC = 0;

        if (mining_details) {
        const { start_time, hashpower, updatedAt } = mining_details;

        if (start_time && hashpower && hashpower > 0) {
            const now = Date.now();
            const lastUpdateTime = new Date(updatedAt).getTime();
            const elapsed = now - start_time;
            const sinceLastUpdate = now - lastUpdateTime;

            if (sinceLastUpdate < MAX_MINING_DURATION_MS) {
            const miningDurationSec = Math.min(elapsed / 1000, MAX_MINING_DURATION_MS / 1000);
            accumulatedBTC = (hashpower * BTC_PER_HASHPOWER_PER_SEC) * miningDurationSec;
            }
        }
        }

        const btcToTransfer = accumulatedBTC;

        bal.BTC_DEPOSIT = parseFloat(bal.BTC_DEPOSIT.toString()) + btcToTransfer;
        bal.BTC = 0;
        await bal.save();
        // console.log(`Transferred ${btcToTransfer} BTC to BTC_DEPOSIT for user ${bal.user}`);

        await BalanceHistory.findOneAndUpdate(
        { user: bal.user, date: today },
        {
            $set: {
            user: bal.user,
            date: today,
            balances: {
                BNB: bal.BNB,
                USDT: bal.USDT,
                USDC: bal.USDC,
                BTC: accumulatedBTC,
                LTC: bal.LTC,
            },
            },
        },
        { upsert: true, new: true }
        );

    } catch (innerErr) {
        console.error(`Error processing user balance ${bal.user}:`, innerErr);
    }
    }

  console.log("Balances updated and accumulated BTC deposited.");

  // 4 Archive and reset daily reward claims
  const allClaimedRewards = await DailyRewardClaim.find({});

  if (allClaimedRewards.length > 0) {
    const historyEntries = allClaimedRewards.map((claim) => ({
      userId: claim.userId,
      rewardId: claim.rewardId,
      claimedAt: claim.claimedAt,
      createdAt: claim.createdAt,
      updatedAt: claim.updatedAt,
    }));

    await DailyRewardClaimHistory.insertMany(historyEntries);
    await DailyRewardClaim.deleteMany({});
  }

  console.log("Daily reward claims reset.");

  // 5 Reset UserMiningDetails
  await UserMiningDetail.updateMany(
    {},
    {
      $set: {
        hashpower: 0,
        mining_isactive: false,
        rewarded_ads_watched: 0,
        thirty_gh_rewarded_ads_watched: 0,
        random_ads_watched: 0,
        start_time: 0,
        stop_time: 0,
      },
    }
  );

  console.log("User mining details reset.");
  console.log("Daily snapshot complete.");
  process.exit(0);
} catch (err) {
  console.error("Error saving daily snapshots:", err);
  process.exit(1);
}
