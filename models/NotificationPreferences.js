import mongoose from "mongoose";

const NotificationPreferencesSchema = new mongoose.Schema({
  user: {
    type: String,
    ref: 'users',
    required: true
  },
  firebase_uid: {
    type: String,
    ref: 'users',
    index: true
  },
  email: {
    type: Boolean,
    default: false,
  },
  push: {
    type: Boolean,
    default: false,
  },
  sms: {
    type: Boolean,
    default: false,
  },
}, { timestamps: true });

export default mongoose.model("NotificationPreferences", NotificationPreferencesSchema);
