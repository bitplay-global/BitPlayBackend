import mongoose from "mongoose";

const { Schema } = mongoose;

const DailyRewardClaimSchema = new Schema(
  {
    userId: { type: String, ref: "users", required: true },
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

const DailyRewardClaim = mongoose.model("DailyRewardClaim", DailyRewardClaimSchema);
export default DailyRewardClaim;
