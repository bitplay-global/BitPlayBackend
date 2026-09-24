// resetGoogleAds.js
import mongoose from "mongoose";
import GoogleAd from "../models/GoogleAds.js";

const MONGO_URI = process.env.MONGODB_URI;

async function run() {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("Connected to MongoDB");

    // 1. Remove everything from the collection
    await GoogleAd.deleteMany({});
    console.log("Cleared all existing GoogleAds");

    // 2. Define new ads
    const ads = [
      {
        platform: "ios",
        ad_id: "ca-app-pub-3940256099942544/1712485313",
        ad_type: "rewarded_video",
        production: false,
      },
      {
        platform: "android",
        ad_id: "ca-app-pub-3940256099942544/5224354917",
        ad_type: "rewarded_video",
        production: false,
      },
      {
        platform: "ios",
        ad_id: "ca-app-pub-3940256099942544/2934735716",
        ad_type: "home_banner",
        production: false,
      },
      {
        platform: "android",
        ad_id: "ca-app-pub-3940256099942544/6300978111",
        ad_type: "home_banner",
        production: false,
      },
    ];

    await GoogleAd.insertMany(ads);
    console.log("Inserted new GoogleAds:", ads);

  } catch (err) {
    console.error("Error resetting GoogleAds:", err);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from MongoDB");
  }
}

run();
