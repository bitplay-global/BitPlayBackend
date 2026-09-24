// updateSubscriptionPlans.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
import SubscriptionPlan from './bitcoin_mining_backend/bitcoin_mining_backend/bitcoin_mining_backend/bitcoin_mining_backend/bitcoin_mining_backend/bitcoin_mining_backend/bitcoin_mining_backend/bitcoin_mining_backend/models/SubscriptionPlan.js';

async function updatePlans() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const result = await SubscriptionPlan.updateMany({}, {
      $set: {
        apple_identifier: '',
        google_identifier: ''
      }
    });
    console.log('Update result:', result);
    await mongoose.disconnect();
  } catch (err) {
    console.error('Error updating SubscriptionPlans:', err);
    process.exit(1);
  }
}

updatePlans();
