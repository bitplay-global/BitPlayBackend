import mongoose from "mongoose";
import DailyRewardClaim from "../models/DailyRewardClaim.js";

const MONGO_URI = process.env.MONGODB_URI;

const deleteAllMiningDetails = async () => {
  try {
    await mongoose.connect(MONGO_URI);
    const result = await DailyRewardClaim.deleteMany({});
    console.log(`Deleted ${result.deletedCount} records from UserMiningDetail.`);
  } catch (err) {
    console.error("Error deleting records:", err);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
};

deleteAllMiningDetails();