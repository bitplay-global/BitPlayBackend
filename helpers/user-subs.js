// /helpers/user-subs.js
import mongoose from "mongoose";
import UserPlans from "../models/UserPlans.js";

const MONGO_URI = process.env.MONGODB_URI;

async function main() {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    const user_plans = await UserPlans.find({}).lean();

    if (!user_plans.length) {
      console.log("No Deposit User Subs found.");
    } else {
      console.log(`Found ${user_plans.length} Subs:\n`);
      user_plans.forEach((a, i) => {
        console.log(`${i + 1}.`, a); // print full document
      });
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error("Error fetching User Subs:", err.message);
    process.exit(1);
  }
}

main();