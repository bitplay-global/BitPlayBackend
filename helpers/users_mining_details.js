// /helpers/list_db_addresses.js
import mongoose from "mongoose";
import UserMiningDetail from "../models/UserMiningDetails.js";

const MONGO_URI = process.env.MONGODB_URI;

async function main() {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    const mining_details = await UserMiningDetail.find({}).lean();

    if (!mining_details.length) {
      console.log("No UserMiningDetails found.");
    } else {
      console.log(`Found ${mining_details.length} mining_details:\n`);
      mining_details.forEach((a, i) => {
        console.log(`${i + 1}.`, a); // print full document
      });
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error("Error fetching UserMiningDetails:", err.message);
    process.exit(1);
  }
}

main();

// 20. {
//   _id: new ObjectId('68f72e945244be893f13f6ab'),
//   user: 'oyMTdgjQfERbctpzbot9AklnASq2',
//   __v: 0,
//   createdAt: 2025-10-21T06:56:20.382Z,
//   hashpower: 132,
//   local_start_time: '21/10/2025, 3:38:40 PM',
//   local_stop_time: null,
//   mining_isactive: false,
//   offset: -240,
//   random_ads_watched: 0,
//   rewarded_ads_watched: 10,
//   start_time: 1761029780087,
//   stop_time: null,
//   updatedAt: 2025-10-21T11:38:41.306Z
// }