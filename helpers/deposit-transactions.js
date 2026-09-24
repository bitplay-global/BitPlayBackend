// /helpers/list_db_addresses.js
import mongoose from "mongoose";
import Deposit from "../models/Deposit.js";

const MONGO_URI = process.env.MONGODB_URI;

async function main() {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    const transactions = await Deposit.find({ chain: "btc" }).lean();

    if (!transactions.length) {
      console.log("No Deposit Transactions found.");
    } else {
      console.log(`Found ${transactions.length} Transactions:\n`);
      transactions.forEach((a, i) => {
        console.log(`${i + 1}.`, a); // print full document
      });
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error("Error fetching Deposit Transactions:", err.message);
    process.exit(1);
  }
}

main();
