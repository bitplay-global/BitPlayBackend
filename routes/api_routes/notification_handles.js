import express from 'express';
import NotificationPreference from '../../models/NotificationPreferences.js';
import mongoose from 'mongoose';

const router = express.Router();

router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    let user_preferences = await NotificationPreference.findOne({ user: userId });

    if (!user_preferences) {
      // Default to push notifications enabled (opt-out model)
      // Only create preference record when user explicitly sets it
      user_preferences = {
        user: userId,
        email: false,
        push: true, // Default to enabled
        sms: false,
      };
      // Don't save to DB yet - only save when user explicitly updates preferences
    }

    res.status(200).json({
      success: true,
      user_preferences
    });
  } catch (err) {
    console.error('Error fetching/creating notification preferences:', err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

router.put('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { email, push, sms } = req.body;

    // Find and update, or create if not exists
    let user_preferences = await NotificationPreference.findOneAndUpdate(
      { user: userId },
      { 
        email: email ?? false, 
        push: push ?? false, 
        sms: sms ?? false 
      },
      { new: true, upsert: true } // return updated doc, create if not found
    );

    res.status(200).json({
      success: true,
      user_preferences,
    });
  } catch (err) {
    console.error('Error updating notification preferences:', err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

export default router;