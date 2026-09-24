import mongoose from "mongoose";
import Deposit from "../models/Deposit.js";
import Balance from "../models/Balance.js";

const MONGO_URI = process.env.MONGODB_URI;

await mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// update
await Deposit.updateOne(
  { _id: new mongoose.Types.ObjectId("68cbfe10e9e8b5ceaba6920c") },
  { $set: { amountNumeric: mongoose.Types.Decimal128.fromString("0.00017") } }
);

// await Balance.updateOne(
//   { user: "68cbc9c544790a54101e1b6c" },
//   { $inc: { BTC_DEPOSIT: 0.00017 } },
//   { upsert: true }
// );

console.log("Update successful");
await mongoose.disconnect();