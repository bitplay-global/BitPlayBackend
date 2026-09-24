/**
 * Mining Session API Routes
 */

import express from 'express';
import MiningSession from '../../models/MiningSession.js';

const router = express.Router();

/**
 * POST /api/mining-sessions/start
 *
 * Start or update a mining session
 */
router.post('/start', async (req, res) => {
  try {
    const { user_id, hash_power, ads_watched, start_time } = req.body;

    if (!user_id || hash_power === undefined || ads_watched === undefined || !start_time) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: user_id, hash_power, ads_watched, start_time'
      });
    }

    const startDate = new Date(parseInt(start_time));
    const endDate = new Date(startDate.getTime() + (24 * 60 * 60 * 1000)); // 24 hours

    // Find existing active session or create new one
    let session = await MiningSession.findOne({
      user_id,
      status: 'active'
    });

    if (session) {
      // Update existing session
      session.hash_power = hash_power;
      session.ads_watched = ads_watched;
      session.start_time = startDate;
      session.end_time = endDate;
      await session.save();

      console.log(`Updated mining session for user ${user_id}`);
    } else {
      // Create new session
      session = await MiningSession.create({
        user_id,
        start_time: startDate,
        end_time: endDate,
        hash_power,
        ads_watched,
        status: 'active'
      });

      console.log(`Created new mining session for user ${user_id}`);
    }

    res.status(200).json({
      success: true,
      message: 'Mining session synced successfully',
      session: {
        id: session._id,
        user_id: session.user_id,
        start_time: session.start_time,
        end_time: session.end_time,
        hash_power: session.hash_power,
        ads_watched: session.ads_watched,
        status: session.status
      }
    });

  } catch (error) {
    console.error('Error starting/updating mining session:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

/**
 * POST /api/mining-sessions/update
 *
 * Update mining session (e.g., after watching a video)
 */
router.post('/update', async (req, res) => {
  try {
    const { user_id, hash_power, ads_watched } = req.body;

    if (!user_id || hash_power === undefined || ads_watched === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: user_id, hash_power, ads_watched'
      });
    }

    // Find active session
    const session = await MiningSession.findOne({
      user_id,
      status: 'active'
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'No active mining session found'
      });
    }

    // Update session
    session.hash_power = hash_power;
    session.ads_watched = ads_watched;
    await session.save();

    console.log(`Updated mining session for user ${user_id}: ${ads_watched} ads watched`);

    res.status(200).json({
      success: true,
      message: 'Mining session updated successfully',
      session: {
        id: session._id,
        hash_power: session.hash_power,
        ads_watched: session.ads_watched
      }
    });

  } catch (error) {
    console.error('Error updating mining session:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

/**
 * POST /api/mining-sessions/stop
 *
 * Stop a mining session
 */
router.post('/stop', async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({
        success: false,
        message: 'Missing required field: user_id'
      });
    }

    // Find and stop active session
    const session = await MiningSession.findOne({
      user_id,
      status: 'active'
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'No active mining session found'
      });
    }

    session.status = 'stopped';
    await session.save();

    console.log(`Stopped mining session for user ${user_id}`);

    res.status(200).json({
      success: true,
      message: 'Mining session stopped successfully'
    });

  } catch (error) {
    console.error('Error stopping mining session:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

/**
 * GET /api/mining-sessions/status/:userId
 *
 * Get current mining session status
 */
router.get('/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const session = await MiningSession.findOne({
      user_id: userId,
      status: 'active'
    });

    res.status(200).json({
      success: true,
      session: session ? {
        id: session._id,
        user_id: session.user_id,
        start_time: session.start_time,
        end_time: session.end_time,
        hash_power: session.hash_power,
        ads_watched: session.ads_watched,
        status: session.status,
        time_remaining: Math.max(0, session.end_time - new Date())
      } : null
    });

  } catch (error) {
    console.error('Error getting mining session status:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
});

export default router;
