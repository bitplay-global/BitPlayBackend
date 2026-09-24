import mongoose from "mongoose";

const { Schema } = mongoose;

const DailyRewardSchema = new Schema(
  {
    day: { type: Number, required: false, default: null },
    isRecurring: { type: Boolean, default: false },
    rewardType: { type: String, required: true }, 
    amount: { type: Number, required: true },
  },
  { timestamps: true }
);

// Prevent duplicate day-based rewards
DailyRewardSchema.index(
  { day: 1 },
  { unique: true, partialFilterExpression: { isRecurring: false } }
);

const DailyReward = mongoose.model("DailyReward", DailyRewardSchema);
export default DailyReward;
