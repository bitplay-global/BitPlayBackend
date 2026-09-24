import express from 'express';
import SubscriptionPlan from '../../models/SubscriptionPlan.js';
import Userplan from '../../models/UserPlans.js';
import { v4 as uuidv4 } from 'uuid';
import { requireAdminAuth } from "../../middleware/requireAdminAuth.js";

const router = express.Router();

router.post('/create', requireAdminAuth, async (req, res) => {
  try {
    const { name, hashrate, hashrate_unit, duration, maintenance_cost, plan_cost, apple_identifier, google_identifier } = req.body;

    const newPlan = new SubscriptionPlan({
      id: uuidv4(),
      name,
      hashrate: parseFloat(hashrate),
      duration: parseInt(duration),
      unit: hashrate_unit,
      maintenance_cost: parseFloat(maintenance_cost),
      plan_cost: parseFloat(plan_cost),
      apple_identifier: apple_identifier || "",
      google_identifier: google_identifier || ""
    });

    await newPlan.save();

    res.redirect('/admin/subscriptionplans');
  } catch (error) {
    console.error('Error creating subscription plan:', error);
    res.status(500).send('Internal Server Error');
  }
});

router.post('/create_user_sub', async (req, res) => {
  try {
    const { user, plan_id, crypto, chain, paymentMethod } = req.body;

    if (!user || !plan_id || !crypto || !chain || !paymentMethod) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 1. Validate SubscriptionPlan exists
    const plan = await SubscriptionPlan.findOne({ id: plan_id });
    if (!plan) {
      return res.status(404).json({ error: "Subscription plan not found" });
    }

    // 2. Calculate total cost
    const totalAmount = plan.maintenance_cost + plan.plan_cost;

    // 3. Payment method booleans
    let method_crypto = false;
    let method_bank_transfer = false;
    let method_payment_gateway = false;

    if (paymentMethod.toLowerCase() === "crypto") {
      method_crypto = true;
    } else if (paymentMethod.toLowerCase() === "bank") {
      method_bank_transfer = true;
    } else if (paymentMethod.toLowerCase() === "gateway") {
      method_payment_gateway = true;
    } else {
      return res.status(400).json({ error: "Invalid payment method" });
    }

    // 4. Upsert Userplan
    const userPlan = await Userplan.findOneAndUpdate(
      { user, plan_id },
      {
        user,
        crypto,
        chain,
        amount: totalAmount,
        hashrate: plan.hashrate,
        plan_id: plan.id,
        method_crypto,
        method_bank_transfer,
        method_payment_gateway,
        paid: false, // always unpaid initially
      },
      { new: true, upsert: true }
    );

    return res.json({ message: "User plan updated successfully", userPlan });
  } catch (err) {
    console.error("Error updating Userplan:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get('/', async (req, res) => {
  try {
    const plans = await SubscriptionPlan.find().sort({ plan_cost: 1 });
    res.status(200).json({ success: true, plans });
  } catch (err) {
    console.error('Error fetching subscription plans:', err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

router.delete('/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await SubscriptionPlan.findOneAndDelete({ id });

    if (!result) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    res.status(200).json({ message: 'Plan deleted' });
  } catch (err) {
    console.error('Error deleting plan:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET total hashpower for a user
router.get("/hashpower/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    // Find all Userplan records for this user that are paid
    const userPlans = await Userplan.find({ user: userId, paid: true });

    if (!userPlans.length) {
      return res.json({ hashpower: 0 });
    }

    // Sum the hashrate
    const totalHashrate = userPlans.reduce((acc, plan) => acc + plan.hashrate, 0);

    return res.json({ hashpower: totalHashrate });
  } catch (err) {
    console.error("Error fetching user hashpower:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.delete('/usersub/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await SubscriptionPlan.findOneAndDelete({ id });

    if (!result) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    res.status(200).json({ message: 'Plan deleted' });
  } catch (err) {
    console.error('Error deleting plan:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
