import BalanceHistory from "../models/BalanceHistory.js";
import mongoose from 'mongoose';

const MONGO_URI =
  process.env.MONGODB_URI;

await mongoose.connect(MONGO_URI);

const oldRecords = await BalanceHistory.find({
  date: {
    $gte: new Date("2027-01-01T00:00:00.000Z"),
    $lt: new Date("2028-01-01T00:00:00.000Z"),
  },
});

if (oldRecords.length > 0) {
  console.log(`Found ${oldRecords.length} BalanceHistory record(s) from 2027:`);
  oldRecords.forEach((record) => console.log(`- ID: ${record._id}, User: ${record.user}, Date: ${record.date}`));

  const deleteResult = await BalanceHistory.deleteMany({
    date: {
      $gte: new Date("2027-01-01T00:00:00.000Z"),
      $lt: new Date("2028-01-01T00:00:00.000Z"),
    },
  });

  console.log(`Deleted ${deleteResult.deletedCount} outdated BalanceHistory record(s) from 2027`);
} else {
  console.log("No BalanceHistory records found from 2027");
}