import mongoose from "mongoose";

const { Schema } = mongoose;

const DailyFreeMinerSchema = new Schema(
  {
    userId: { type: String, ref: "users", required: true },
    claimedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const DailyFreeMiner = mongoose.model("DailyFreeMiner", DailyFreeMinerSchema);
export default DailyFreeMiner;
