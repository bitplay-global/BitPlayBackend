import mongoose from "mongoose";
import UserMiningDetail from "../models/UserMiningDetails.js";

const MONGO_URI = process.env.MONGODB_URI;

const updateUserMiningDetails = async () => {
  try {
    await mongoose.connect(MONGO_URI);

    const userId = "686a6a39193765138976f1a2";

    const updateData = {
      hashpower: 15,
      rewarded_ads_watched: 3,
      thirty_gh_rewarded_ads_watched: 0,
      mining_isactive: true,
      local_start_time: "20/10/2025, 5:00:00 PM",
      offset: -330,
      local_stop_time: null,
      stop_time: null,
      start_time: 1760915079129
    };

    const result = await UserMiningDetail.findOneAndUpdate(
      { user: userId },
      { $set: updateData },
      { new: true, upsert: false }
    );

    if (result) {
      console.log("User mining details updated successfully:");
      console.log(result);
    } else {
      console.log(`No document found for user ID ${userId}.`);
    }
  } catch (err) {
    console.error("Error updating mining details:", err);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
};

updateUserMiningDetails();
