// /helpers/list_db_addresses.js
import mongoose from "mongoose";
import WalletAddress from "../models/WalletAddress.js";

const MONGO_URI = process.env.MONGODB_URI;

async function main() {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    const addrs = await WalletAddress.find({ chain: "btc" }).lean();

    if (!addrs.length) {
      console.log("No BTC addresses found in WalletAddress collection.");
    } else {
      console.log(`Found ${addrs.length} BTC deposit addresses:\n`);
      addrs.forEach((a, i) => {
        console.log(`${i + 1}.`, a); // print full document
      });
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error("Error fetching wallet addresses:", err.message);
    process.exit(1);
  }
}

main();
