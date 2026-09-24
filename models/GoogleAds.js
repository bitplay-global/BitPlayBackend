// models/GoogleAd.js
import mongoose from 'mongoose';

const GoogleAdSchema = new mongoose.Schema({
  platform: {
    type: String,
    required: true
  },
  ad_id: {
    type: String,
    required: true
  },
  ad_type: {
    type: String,
    required: true
  },
  production: {
    type: Boolean,
    default: false,
  },
});

const GoogleAd = mongoose.models.GoogleAd || mongoose.model('GoogleAd', GoogleAdSchema);
export default GoogleAd;
