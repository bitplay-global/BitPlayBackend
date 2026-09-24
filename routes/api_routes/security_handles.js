import express from 'express';
import mongoose from 'mongoose';

const router = express.Router();

let usersCollection;

mongoose.connection.once('open', () => {
  usersCollection = mongoose.connection.db.collection('users');
  console.log('Users collection is ready to use.');
});

// POST route to toggle 2FA
router.post('/switch', async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!usersCollection) {
      return res.status(500).json({
        success: false,
        message: 'Database not ready',
      });
    }

    const user = await usersCollection.findOne({ _id: new mongoose.Types.ObjectId(user_id) });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    const newStatus = !(typeof user.TwoFactorAuth === 'boolean' ? user.TwoFactorAuth : false);

    await usersCollection.updateOne(
      { _id: new mongoose.Types.ObjectId(user_id) },
      { $set: { TwoFactorAuth: newStatus } }
    );

    return res.status(200).json({
      success: true,
      message: '2FA status updated.',
      twoFactorStatus: newStatus,
    });
  } catch (error) {
    console.error('Error changing User 2FA Status:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal Server Error',
    });
  }
});

// GET route to fetch 2FA status
router.get('/2fa-status/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;

    if (!usersCollection) {
      return res.status(500).json({
        success: false,
        message: 'Database not ready',
      });
    }

    const user = await usersCollection.findOne(
      { _id: new mongoose.Types.ObjectId(user_id) },
      { projection: { TwoFactorAuth: 1 } }
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    const twoFactorStatus = typeof user.TwoFactorAuth === 'boolean' ? user.TwoFactorAuth : false;

    return res.status(200).json({
      success: true,
      twoFactorStatus,
    });
  } catch (error) {
    console.error('Error fetching 2FA status:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal Server Error',
    });
  }
});

export default router;
