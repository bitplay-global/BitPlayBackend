import express from 'express';
import { appUserAuth } from '../middleware/appUserAuth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import WebUsers from '../models/WebUsers.js';
import mongoose from 'mongoose';
import transactionRoutes from './api_routes/transactions.js';
import subscriptionRoutes from './api_routes/subscriptions.js';
import faqRoutes from './api_routes/faqs.js';
import UserRoutes from './api_routes/users.js'
import HelpRoutes from './api_routes/support.js'
import ClaimRewardRoutes from './api_routes/dailyRewardController.js'
import { escapeRegex } from "../helpers/escapeRegex.js";

import alchemyy_deposits from './api_routes/alchemy_deposit.js';
import wallet_balance_handles from './api_routes/balance.js';
import withdrawal_handles from './api_routes/withdrawal_routes.js';
import firebase_token_handle from './api_routes/firebase_notifications.js';
import lightning_handles from './api_routes/lightning-handle.js';
import notification_handles from './api_routes/notification_handles.js'
import google_ads_handle from './api_routes/google_ads.js'
import delete_handles from './api_routes/delete_handles.js'
import security_handles from './api_routes/security_handles.js'
import user_mining_handles from './api_routes/user-mining-handles.js'
import claim_daily_miner from './api_routes/daily-miner-handles.js'
import purchase_handles from './api_routes/purchases.js'
import privilege_handles from './api_routes/privileges.js'
import news_handles from './api_routes/news.js'
import mining_session_handles from './api_routes/mining-session-handles.js'
import { getDashboardStats, getDashboardStatsFiltered } from '../helpers/dashboardStats.js';
import { requireAdminAuth } from "../middleware/requireAdminAuth.js";
import { getVersionPolicy } from '../helpers/versionPolicy.js';
import { getBtcUsdPriceCached } from '../helpers/btcPrice.js';

const router = express.Router();

// Public: app version policy for mobile app update modal.
// Every /api request passes through here first: a valid app token becomes the
// only user the request may act as. See middleware/appUserAuth.js.
router.use(appUserAuth);

// Rate limits for abusable endpoints (per verified user, else per IP). Generous
// on purpose: many mobile users can share one carrier IP. See middleware/rateLimit.js.
const MIN15 = 15 * 60 * 1000;
router.post(['/withdrawals', '/withdrawals/create-speed-payment'], rateLimit({ name: 'withdrawal-create', windowMs: MIN15, max: 10 }));
router.post(['/purchases/:userId', '/privileges/:userId'], rateLimit({ name: 'purchase-grant', windowMs: MIN15, max: 20 }));
router.post('/security/switch', rateLimit({ name: '2fa-switch', windowMs: MIN15, max: 10 }));
router.get(['/deposit-address/:userId', '/deposit-address/:userId/:asset'], rateLimit({ name: 'deposit-address', windowMs: MIN15, max: 30 }));
router.post('/help/create', rateLimit({ name: 'support-ticket', windowMs: MIN15, max: 10 }));
router.post('/firebase_tokens/mining-stopped', rateLimit({ name: 'push-trigger', windowMs: MIN15, max: 30 }));
router.post(['/daily-rewards/claim', '/claim_daily_miner', '/user_mining/:game-history/claim', '/user_mining/trading-claim'], rateLimit({ name: 'reward-claim', windowMs: MIN15, max: 60 }));

/**
 * BTC/USD price, so the app has a source of its own when CoinGecko and Binance
 * are unreachable or rate-limiting it. Same cached helper the withdrawal
 * validation uses, so app and server agree on the rate.
 * `usd: null` means no source answered and nothing is cached -- the app shows
 * the value as unavailable rather than as zero.
 */
router.get('/btc-price', async (req, res) => {
  try {
    const usd = await getBtcUsdPriceCached(60_000);
    return res.json({ success: usd > 0, usd: usd > 0 ? usd : null, asOf: new Date().toISOString() });
  } catch (error) {
    console.error('BTC price error:', error.message);
    return res.json({ success: false, usd: null, asOf: new Date().toISOString() });
  }
});

router.get('/app-version-policy', async (req, res) => {
  try {
    const policy = await getVersionPolicy();
    return res.json(policy);
  } catch (error) {
    console.error('App version policy error:', error.message);
    return res.status(500).json({
      enabled: false,
      mode: 'none',
      latestVersion: '',
      minSupportedVersion: '',
      forceUpdateBelowVersion: '',
      title: '',
      message: '',
      buttonText: '',
      dismissible: true,
      android: {},
      ios: {},
    });
  }
});

// Get dashboard stats (optional: startDate, endDate, or range=all for filtered data)
router.get('/dashboard-stats', requireAdminAuth, async (req, res) => {
  try {
    const { startDate, endDate, range } = req.query;
    const allTime = range === 'all';
    const useFilter = allTime || startDate || endDate;
    const stats = useFilter
      ? await getDashboardStatsFiltered({
          startDate: startDate || undefined,
          endDate: endDate || undefined,
          allTime,
        })
      : await getDashboardStats();
    res.json(stats);
  } catch (error) {
    console.error('Dashboard stats error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard stats',
    });
  }
});

// Update support ticket status
router.put('/support/:id/status', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    const response = await axios.put(
      `${process.env.BACKEND_API_URL}/admin/support/${id}/status`,
      { status }
    );
    
    res.json(response.data);
  } catch (error) {
    console.error('Update ticket status error:', error.message);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update ticket status' 
    });
  }
});

router.post('/profile/save', requireAdminAuth, async (req, res) => {
  try {
    const username = req.session.adminUser || req.session.adminUserData?.username;
    if (!username) {
      req.session.errorMessage = 'Not logged in.';
      return res.redirect('/admin/login');
    }

    const {
      firstname,
      lastname,
      orgname,
      location,
      email,
      phone,
    } = req.body;

    const existingUser = await WebUsers.findOne({ username });

    if (existingUser) {
      existingUser.firstname = firstname ?? existingUser.firstname;
      existingUser.lastname = lastname ?? existingUser.lastname;
      existingUser.orgname = orgname ?? existingUser.orgname;
      existingUser.location = location ?? existingUser.location;
      existingUser.phone = phone ?? existingUser.phone;
      existingUser.email = email ?? existingUser.email;
      await existingUser.save();
    } else {
      await WebUsers.create({
        username,
        firstname: firstname || username,
        lastname: lastname || '',
        orgname: orgname || '',
        location: location || '',
        email: email || '',
        phone: phone || '',
      });
    }

    req.session.successMessage = 'Profile updated successfully!';
    return res.redirect('/admin/profile');
  } catch (err) {
    console.error('Error saving profile:', err);
    req.session.errorMessage = 'Failed to update profile. Please try again.';
    return res.redirect('/admin/profile');
  }
});

// Public read for mobile app (same trust model as wallet balance by userId).
// Counts active users who signed up with this referral code.
router.get("/referrals", async (req, res) => {
  try {
    const { code } = req.query;

    if (!code || typeof code !== "string") {
      return res.status(400).json({
        success: false,
        message: "Referral code is required",
      });
    }

    // Directly query MongoDB collection instead of User model
    const usersCollection = mongoose.connection.collection("users");

    // Count only ACTIVE users who used this referral code
    // escapeRegex: `code` comes straight from the query string. Unescaped, a
    // request of ?code=.* counted every active user in the database.
    const count = await usersCollection.countDocuments({
      referralUsed: { $regex: `^${escapeRegex(code)}$`, $options: "i" }, // case-insensitive
      isActive: true  // Only count active users
    });

    console.log(`Referral count for ${code}: ${count} active users`);

    res.json({
      success: true,
      referralCode: code,
      count,
    });
  } catch (error) {
    console.error("Fetching error:", error.message);
    res.status(500).json({
      success: false,
      message: "Failed to fetch user referrals",
    });
  }
});

// Public read for mobile app: total referral rewards earned as referrer (parent).
router.get("/referrals/rewards/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "User ID is required",
      });
    }

    const ReferralRewardHistory = (await import("../models/ReferralRewardHistory.js")).default;

    // Get all processed rewards for this user as parent
    const rewards = await ReferralRewardHistory.find({
      parentUserId: userId,
      status: 'processed'
    }).lean();

    // Calculate total reward amount
    // Use high precision to handle very small amounts
    let totalRewards = 0;
    rewards.forEach(reward => {
      // Decimal128 values need to be converted properly
      const amountStr = reward.rewardAmount?.toString() || "0";
      const amount = parseFloat(amountStr);
      totalRewards += amount;
    });

    // Format with up to 16 decimal places to preserve precision for very small amounts
    // If the value is less than 0.00000001, show more decimal places
    let formattedTotal;
    if (totalRewards < 0.00000001 && totalRewards > 0) {
      // For very small amounts, use scientific notation or show more decimals
      formattedTotal = totalRewards.toFixed(16).replace(/\.?0+$/, ''); // Remove trailing zeros
    } else {
      formattedTotal = totalRewards.toFixed(8).replace(/\.?0+$/, ''); // Standard 8 decimals, remove trailing zeros
    }

    console.log(`[Referral Rewards API] Total rewards for user ${userId}: ${totalRewards} (formatted: ${formattedTotal})`);

    res.json({
      success: true,
      totalRewards: formattedTotal,
      totalRewardsRaw: totalRewards, // Also include raw value for precision
      rewardsCount: rewards.length,
      rewards: rewards.map(r => ({
        childUserId: r.childUserId,
        rewardDate: r.rewardDate,
        childDailyMining: r.childDailyMining?.toString() || "0",
        rewardAmount: r.rewardAmount?.toString() || "0",
        status: r.status
      }))
    });
  } catch (error) {
    console.error("Error fetching referral rewards:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch referral rewards",
      error: error.message
    });
  }
});


router.use('/faqs', faqRoutes);
router.use('/help', HelpRoutes);
router.use('/users', UserRoutes);
router.use('/transactions', transactionRoutes);
router.use('/subscriptionplans', subscriptionRoutes);
router.use('/daily-rewards', ClaimRewardRoutes);
router.use('/withdrawals', withdrawal_handles);
router.use('/notification-preferences', notification_handles);

// Crypto Stuff

router.use('/deposit-address', alchemyy_deposits);
router.use('/wallet', wallet_balance_handles);
router.use('/firebase_tokens', firebase_token_handle);
router.use('/lightning-handles', lightning_handles);
router.use('/google-ads', google_ads_handle);

router.use('/delete-handles', delete_handles);
router.use('/security', security_handles);
router.use('/user_mining', user_mining_handles);
router.use('/claim_daily_miner', claim_daily_miner);
router.use('/purchases', purchase_handles);
router.use('/privileges', privilege_handles);
router.use('/news', news_handles);
router.use('/mining-sessions', mining_session_handles);


export default router;
