// models/FirebaseNotificationModels.js
import mongoose from 'mongoose';

const FirebaseNotificationsSchema = new mongoose.Schema({
  user_id: {
    type: String,
    ref: 'users',
    required: true
  },
  firebase_uid: {
    type: String,
    ref: 'users',
    index: true
  },
  token: {
    type: String,
    required: true
  },
});

// Every send looks tokens up by user_id; without this each lookup scanned the
// whole collection, and a broadcast ran thousands of those scans at once.
FirebaseNotificationsSchema.index({ user_id: 1 });

const FirebaseNotifications = mongoose.models.FirebaseNotifications || mongoose.model('FirebaseNotifications', FirebaseNotificationsSchema);
export default FirebaseNotifications;
