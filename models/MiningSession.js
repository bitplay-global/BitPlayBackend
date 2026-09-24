/**
 * Mining Session Model
 *
 */

import mongoose from 'mongoose';

const MiningSessionSchema = new mongoose.Schema({
  user_id: {
    type: String,
    ref: 'User',
    required: true,
    index: true, // Index for faster queries
  },
  start_time: {
    type: Date,
    required: true,
  },
  end_time: {
    type: Date,
    required: true,
    index: true, // Index to quickly find expired sessions
  },
  hash_power: {
    type: Number,
    default: 0,
  },
  ads_watched: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ['active', 'expired', 'stopped'],
    default: 'active',
    index: true,
  },
  // Notification tracking (prevents duplicate notifications)
  notifications_sent: {
    expiry_warning: {
      type: Boolean,
      default: false,
    },
    expired: {
      type: Boolean,
      default: false,
    },
    video_reminder: {
      type: Boolean,
      default: false,
    },
  },
  last_video_reminder: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

// Index for efficient querying
MiningSessionSchema.index({ user_id: 1, status: 1 });
MiningSessionSchema.index({ end_time: 1, status: 1 });

/**
 * Find active sessions that are about to expire (within 1 hour)
 */
MiningSessionSchema.statics.findExpiringSoon = function() {
  const now = new Date();
  const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

  return this.find({
    status: 'active',
    end_time: {
      $gte: now,
      $lte: oneHourFromNow,
    },
    'notifications_sent.expiry_warning': false,
  });
};

/**
 * Find expired sessions that haven't been notified
 *
 */
MiningSessionSchema.statics.findExpiredNotNotified = function() {
  return this.find({
    status: 'active',
    end_time: { $lt: new Date() },
    'notifications_sent.expired': false,
  });
};

/**
 * Find active sessions with low video count (< 5 videos watched)
 */
MiningSessionSchema.statics.findNeedingVideoReminder = function() {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  return this.find({
    status: 'active',
    ads_watched: { $lt: 5 },
    $or: [
      { last_video_reminder: null },
      { last_video_reminder: { $lt: oneDayAgo } },
    ],
  });
};

/**
 * Mark session as expired and update status
 */
MiningSessionSchema.methods.markAsExpired = async function() {
  this.status = 'expired';
  await this.save();
};

/**
 * Record that notification was sent
 */
MiningSessionSchema.methods.recordNotification = async function(notificationType) {
  if (notificationType === 'expiry_warning') {
    this.notifications_sent.expiry_warning = true;
  } else if (notificationType === 'expired') {
    this.notifications_sent.expired = true;
    this.status = 'expired';
  } else if (notificationType === 'video_reminder') {
    this.last_video_reminder = new Date();
  }

  await this.save();
};

const MiningSession = mongoose.model('MiningSession', MiningSessionSchema);

export default MiningSession;
