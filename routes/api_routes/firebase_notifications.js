import express from 'express';
import FirebaseNotifications from '../../models/FirebaseNotificationModels.js';
import { sendMiningStoppedNotification, sendCustomNotification } from '../../services/notificationService.js';
import { requireAdminAuth } from "../../middleware/requireAdminAuth.js";
const router = express.Router();

router.post('/create', async (req, res) => {
  try {
    const { user_id, token } = req.body;

    if (!user_id || !token) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    const ticket = await FirebaseNotifications.findOneAndUpdate(
      { user_id },                        
      { user_id, token },                 
      { new: true, upsert: true }         
    );

    res.status(201).json({ success: true, ticket });
  } catch (err) {
    console.error('Error storing FCM:', err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

/**
 * Check user notification status
 * GET /api/firebase_tokens/check/:user_id
 */
router.get('/check/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    
    const userToken = await FirebaseNotifications.findOne({ user_id });
    const NotificationPreferences = (await import('../../models/NotificationPreferences.js')).default;
    const preferences = await NotificationPreferences.findOne({ user: user_id });
    
    res.status(200).json({
      success: true,
      user_id,
      has_fcm_token: !!(userToken && userToken.token),
      fcm_token_preview: userToken?.token ? `${userToken.token.substring(0, 20)}...` : null,
      push_notifications_enabled: preferences ? preferences.push !== false : true, // Defaults to true
      preferences: preferences || { push: true, email: false, sms: false }, // Default values
    });
  } catch (err) {
    console.error('Error checking user status:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Server Error',
      error: err.message 
    });
  }
});

/**
 * Send mining stopped notification
 * POST /api/firebase_tokens/mining-stopped
 * Body: { user_id: "userId" }
 */
router.post('/mining-stopped', async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'user_id is required' 
      });
    }

    // Check if user has FCM token
    const userToken = await FirebaseNotifications.findOne({ user_id });
    
    if (!userToken || !userToken.token) {
      return res.status(404).json({ 
        success: false, 
        message: 'No FCM token found for this user. Please register a token first.',
        user_id 
      });
    }

    // Send mining stopped notification
    const result = await sendMiningStoppedNotification(user_id);

    if (result.success) {
      res.status(200).json({
        success: true,
        message: 'Mining stopped notification sent successfully!',
        user_id,
        notification_sent: true
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send mining stopped notification',
        user_id,
        reason: result.reason || result.error,
        error_code: result.code
      });
    }
  } catch (err) {
    console.error('Error sending mining stopped notification:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Server Error',
      error: err.message 
    });
  }
});

/**
 * Test endpoint - Send custom test notification
 * POST /api/firebase_tokens/test-notification
 * Body: { user_id: "userId", title?: "Custom Title", body?: "Custom Body" }
 * 
 * If title/body not provided, sends default "Mining Stopped" notification
 */
router.post('/custom-notification', requireAdminAuth, async (req, res) => {
  try {
    const { user_id, title, body } = req.body;

    if (!user_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'user_id is required' 
      });
    }

    // Check if user has FCM token
    const userToken = await FirebaseNotifications.findOne({ user_id });
    
    if (!userToken || !userToken.token) {
      return res.status(404).json({ 
        success: false, 
        message: 'No FCM token found for this user. Please register a token first.',
        user_id 
      });
    }

    // Send custom notification or default mining stopped notification
    let result;
    if (title || body) {
      // Custom notification
      result = await sendCustomNotification(
        user_id,
        title || 'Test Notification',
        body || 'This is a test notification',
        { type: 'test', action: 'open_home' }
      );
    } else {
      // Default mining stopped notification
      result = await sendMiningStoppedNotification(user_id);
    }

    if (result.success) {
      res.status(200).json({
        success: true,
        message: 'Notification sent successfully! Check your device.',
        user_id,
        notification_sent: true
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to send notification',
        user_id,
        reason: result.reason || result.error,
        error_code: result.code
      });
    }
  } catch (err) {
    console.error('Error testing notification:', err);
    res.status(500).json({ 
      success: false, 
      message: 'Server Error',
      error: err.message 
    });
  }
});


export default router;