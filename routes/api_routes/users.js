import express from 'express';
import mongoose from 'mongoose';
import axios from 'axios';
import { requireAdminAuth } from "../../middleware/requireAdminAuth.js";

const router = express.Router();

// Update user status
router.put('/:id/status', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    
    const response = await axios.put(
      `${process.env.BACKEND_API_URL}/admin/users/${id}/status`,
      { isActive }
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('Update user status error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update user status' 
    });
  }
});

// Delete user
router.delete('/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const response = await axios.delete(
      `${process.env.BACKEND_API_URL}/admin/users/${id}`
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('Delete user error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete user' 
    });
  }
});

// Update user status
router.post('/update-status', requireAdminAuth, async (req, res) => {
  try {
    const { userId, status } = req.body;

    if (!userId || !status) {
      return res.status(400).json({
        success: false,
        message: 'User ID and status are required'
      });
    }

    if (!['active', 'inactive', 'suspended'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status value'
      });
    }

    const usersCollection = mongoose.connection.db.collection('users');
    const { ObjectId } = mongoose.Types;

    const result = await usersCollection.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { status: status, isActive: status === 'active' } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      message: `User status updated to ${status}`,
      userId: userId,
      status: status
    });

  } catch (error) {
    console.error('Error updating user status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user status'
    });
  }
});

export default router;