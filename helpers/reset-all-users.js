import mongoose from "mongoose";
import Balance from "../models/Balance.js";
import UserMiningDetail from "../models/UserMiningDetails.js";

const MONGO_URI = process.env.MONGODB_URI;

const resetAllUsersMiningData = async () => {
  try {
    await mongoose.connect(MONGO_URI);

    // Reset all user balances
    const balanceResult = await Balance.updateMany(
      {}, // all users
      { $set: { BTC: 0 } }
    );

    console.log(`Reset BTC balance for ${balanceResult.modifiedCount} users.`);

    // Reset all user mining details
    const miningResult = await UserMiningDetail.updateMany(
      {}, // all users
      {
        $set: {
          hashpower: 0,
          mining_isactive: false,
          rewarded_ads_watched: 0,
          thirty_gh_rewarded_ads_watched: 0,
          random_ads_watched: 0,
          start_time: null,
          stop_time: null,
          local_start_time: null,
          local_stop_time: null,
        },
      }
    );

    console.log(`Reset mining details for ${miningResult.modifiedCount} users.`);

  } catch (err) {
    console.error("Error resetting user data:", err);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
};

resetAllUsersMiningData();
