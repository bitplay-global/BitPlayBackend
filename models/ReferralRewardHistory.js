import mongoose from "mongoose";

const referralRewardHistorySchema = new mongoose.Schema({
  parentUserId: {
    type: String,
    ref: 'users',
    required: true,
    index: true
  },
  childUserId: {
    type: String,
    ref: 'users',
    required: true,
    index: true
  },
  rewardDate: {
    type: Date,
    required: true,
    index: true
  },
  childDailyMining: {
    type: mongoose.Schema.Types.Decimal128,
    required: true,
    default: 0
  },
  rewardAmount: {
    type: mongoose.Schema.Types.Decimal128,
    required: true,
    default: 0
  },
  rewardPercentage: {
    type: Number,
    default: 5.0 // 5% default, configurable
  },
  status: {
    type: String,
    enum: ['pending', 'processed', 'failed'],
    default: 'processed'
  },
  notes: {
    type: String,
    default: null
  }
}, { 
  timestamps: true 
});

// Compound indexes for efficient queries and duplicate prevention
referralRewardHistorySchema.index({ parentUserId: 1, rewardDate: -1 });
referralRewardHistorySchema.index({ childUserId: 1, rewardDate: -1 });
referralRewardHistorySchema.index({ parentUserId: 1, childUserId: 1, rewardDate: 1 }, { unique: true });

export default mongoose.model("ReferralRewardHistory", referralRewardHistorySchema);
