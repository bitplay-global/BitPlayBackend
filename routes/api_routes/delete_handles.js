import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import DeleteRequests from '../../models/DeleteRequests.js';

const router = express.Router();

router.post('/create', async (req, res) => {
  try {
    const { user_id, reason } = req.body;

    // Check if a delete request already exists for this user
    const existingReq = await DeleteRequests.findOne({ user: user_id });

    if (existingReq) {
      return res.status(400).json({
        success: false,
        message: 'A delete request already exists for this user.',
      });
    }

    // Otherwise, create a new one
    const new_req = new DeleteRequests({
      user: user_id,
      reason: reason
    });

    await new_req.save();

    return res.status(201).json({
      success: true,
      message: 'Delete request created successfully.',
      request: new_req,
    });
  } catch (error) {
    console.error('Error creating delete request:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal Server Error',
    });
  }
});

export default router;
