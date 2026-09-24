// /helpers/list_db_addresses.js
import mongoose from "mongoose";
import Balance from "../models/Balance.js";

const MONGO_URI = process.env.MONGODB_URI;

async function main() {
  try {
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    const user_id = "68cbc9c544790a54101e1b6c";

    const transactions = await Balance.find({ user: new mongoose.Types.ObjectId(user_id) }).lean();

    if (!transactions.length) {
      console.log("No Balance Transactions found.");
    } else {
      console.log(`Found ${transactions.length} Transactions:\n`);
      transactions.forEach((a, i) => {
        console.log(`${i + 1}.`, a); // print full document
      });
    }

    await mongoose.disconnect();
  } catch (err) {
    console.error("Error fetching Balance Transactions:", err.message);
    process.exit(1);
  }
}

main();
