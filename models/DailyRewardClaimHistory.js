import mongoose from "mongoose";

const { Schema } = mongoose;

const DailyRewardClaimHistorySchema = new Schema(
  {
    userId: { type: String, ref: "User", required: true },
    firebase_uid: {
      type: String,
      ref: 'users',
      index: true
    },
    rewardId: { type: Schema.Types.ObjectId, ref: "DailyReward", required: true },
    claimedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const DailyRewardClaimHistory = mongoose.model("DailyRewardClaimHistory", DailyRewardClaimHistorySchema);
export default DailyRewardClaimHistory;