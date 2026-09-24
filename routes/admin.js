import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import mongoose from 'mongoose';
import dbActions from '../helpers/db_actions.js';
import dbHelpers from '../helpers/helper_functions.js';
import WebUsers from '../models/WebUsers.js';
import DailyReward from "../models/DailyReward.js";
import Withdrawal from "../models/Withdrawal.js";
import FirebaseNotifications from "../models/FirebaseNotificationModels.js";
import DeleteRequests from '../models/DeleteRequests.js';
import Balance from '../models/Balance.js';
import ReferralRewardHistory from '../models/ReferralRewardHistory.js';
import Purchase from '../models/Purchase.js';
import { getBtcUsdPriceCached } from '../helpers/btcPrice.js';
import { getWithdrawalLimits, setWithdrawalLimits } from '../helpers/withdrawalLimits.js';
import { getDashboardStats, getDashboardStatsFiltered, parseDateRange } from '../helpers/dashboardStats.js';
import { saveAdMobTokens, isAdMobConfigured } from '../helpers/admobAuth.js';
import { getVersionPolicy, setVersionPolicy } from '../helpers/versionPolicy.js';
import UserMining from '../models/UserMiningDetails.js';
import MiningSession from '../models/MiningSession.js';
import BalanceHistory from '../models/BalanceHistory.js';
import { sendCustomNotification, sendBulkNotifications } from '../services/notificationService.js';
import AdMultiplierPrivilege from '../models/AdMultiplierPrivilege.js';
import { escapeRegex } from "../helpers/escapeRegex.js";

const { users_count_comparision, transactions_count_comparision, supportTickets_count_comparision } = dbActions;
const {
  total_users,
  total_users_filtered,
  total_transactions,
  TotalSupportTickets,
  TotalSupportTicketsFiltered
} = dbHelpers;
const router = express.Router();

// Middleware to check if admin is logged in
const requireAuth = (req, res, next) => {
  if (req.session.isLoggedIn) {
    next();
  } else {
    res.redirect('/admin/login');
  }
};

// Login page
router.get('/login', (req, res) => {
  if (req.session.isLoggedIn) {
    return res.redirect('/admin/dashboard');
  }
  res.render('login', {
    title: 'Admin Login',
    error: req.session.error || null
  });
  req.session.error = null;
});

// Dashboard admin credentials come only from the environment.
//
// They used to be string literals in this file, which made them a standing
// backdoor: anyone who had ever seen the repository could sign in as admin and
// approve withdrawals. There is deliberately no fallback -- if either variable
// is missing, admin login is refused rather than falling back to a known value.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
  console.error('[Admin] ADMIN_USERNAME / ADMIN_PASSWORD are not set -- admin login is disabled.');
}

// Constant-time comparison, so response timing cannot leak how much of a
// guess was right.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // keep timing flat on a length mismatch
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// Brute-force guard for the login form: 10 failed attempts per IP per 15 minutes.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map();
function tooManyLoginFailures(ip) {
  const entry = loginFailures.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) { loginFailures.delete(ip); return false; }
  return entry.count >= LOGIN_MAX_FAILURES;
}
function recordLoginFailure(ip) {
  const entry = loginFailures.get(ip);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) loginFailures.set(ip, { first: Date.now(), count: 1 });
  else entry.count += 1;
}

// Handle login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const ip = req.ip;
    if (tooManyLoginFailures(ip)) {
      req.session.error = 'Too many failed attempts. Try again in 15 minutes.';
      return res.redirect('/admin/login');
    }
    let adminUser = await WebUsers.findOne({ username });

    // Only allow the configured admin credentials, and only when they are set.
    // Both comparisons always run, so timing does not reveal which one failed.
    const configured = Boolean(ADMIN_USERNAME && ADMIN_PASSWORD);
    const usernameOk = safeEqual(username, ADMIN_USERNAME);
    const passwordOk = safeEqual(password, ADMIN_PASSWORD);
    if (configured && usernameOk && passwordOk) {
      loginFailures.delete(ip);
      if (!adminUser) {
        adminUser = await WebUsers.findOneAndUpdate(
          { username: ADMIN_USERNAME },
          {
            $setOnInsert: {
              firstname: 'Adapt',
              lastname: 'Media',
              username: ADMIN_USERNAME,
              orgname: 'Adapt Media',
              location: '',
              email: 'admin@adaptmedia.com',
              phone: '',
              status: 'active',
            },
          },
          { upsert: true, new: true }
        );
      }
      // Fresh session id on login, so an id planted before login (session
      // fixation) is not the one that becomes authenticated.
      return req.session.regenerate(regenErr => {
        if (regenErr) {
          console.error('Session regenerate error:', regenErr);
          return res.redirect('/admin/login');
        }
        req.session.isLoggedIn = true;
        req.session.adminUser = adminUser.username;
        req.session.adminUserData = adminUser;
        return res.redirect('/admin/dashboard');
      });
    }

    recordLoginFailure(ip);
    req.session.error = 'Invalid credentials';
    res.redirect('/admin/login');
  } catch (error) {
    console.error('Login error:', error);
    req.session.error = 'Login failed';
    res.redirect('/admin/login');
  }
});

// POST /register-admin was removed: it created admin records with no
// authentication at all. Admin access is configured through ADMIN_USERNAME /
// ADMIN_PASSWORD only.

// Dashboard
router.get('/', requireAuth, async (req, res) => {
  res.redirect('/admin/dashboard');
});

// Future dates are never selectable in the admin calendars; this enforces the
// same rule when a date arrives via a hand-edited URL.
const clampToToday = (yyyyMmDd) => {
  if (!yyyyMmDd) return '';
  const today = new Date().toISOString().slice(0, 10);
  return yyyyMmDd > today ? today : yyyyMmDd;
};

router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const rangeAll = req.query.range === 'all';
    let startDate = clampToToday(req.query.startDate || '');
    let endDate = clampToToday(req.query.endDate || '');
    // All time: no date range
    if (rangeAll) {
      startDate = '';
      endDate = '';
    } else if (!startDate && !endDate) {
      // Default: last 30 days when no range provided
      const end = new Date();
      const start = new Date(end);
      start.setDate(start.getDate() - 30);
      startDate = start.toISOString().slice(0, 10);
      endDate = end.toISOString().slice(0, 10);
    }

    const { start, end } = parseDateRange(startDate, endDate, rangeAll);

    const [
      dashboardStats,
      users_diff,
      supportTicketsDiff,
      usersCount,
      supportTicketsCount,
    ] = await Promise.all([
      getDashboardStatsFiltered({
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        allTime: rangeAll,
      }),
      users_count_comparision(),
      supportTickets_count_comparision(),
      rangeAll ? total_users() : total_users_filtered(start, end),
      rangeAll ? TotalSupportTickets() : TotalSupportTicketsFiltered(start, end),
    ]);

    res.render('dashboard', {
      title: 'Dashboard',
      user: req.session.adminUser,
      data: dashboardStats,
      usersCount,
      users_diff,
      supportTicketsCount,
      supportTicketsDiff,
      filterStart: startDate,
      filterEnd: endDate,
      rangeAll: rangeAll,
    });
  } catch (error) {
    console.error('Dashboard error:', error.message);
    const fallbackStats = {
      totalRevenue: 0,
      purchaseTotal: 0,
      admobRevenueIos: 0,
      admobRevenueAndroid: 0,
      admobRevenueTotal: 0,
      admobRevenueTotalUsd: 0,
      admobCurrencyCode: 'USD',
      totalWithdrawals: 0,
      recentWithdrawals: [],
      chartLabels: [],
      chartData: [],
    };
    res.render('dashboard', {
      title: 'Dashboard',
      user: req.session.adminUser,
      data: fallbackStats,
      usersCount: 0,
      users_diff: '0',
      supportTicketsCount: 0,
      supportTicketsDiff: '0',
      filterStart: '',
      filterEnd: '',
      rangeAll: false,
    });
  }
});

router.get('/subscriptionplans', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10;
  const skip = (page - 1) * limit;
  const query = req.query.q?.trim() || '';

  const plansCollection = mongoose.connection.db.collection('subscriptionplans');

  const filter = query
    ? {
      name: { $regex: escapeRegex(query), $options: 'i' },
    }
    : {};

  const plans = await plansCollection
    .find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const total = await plansCollection.countDocuments(filter);

  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ plans });
  }

  res.render('subscriptionplans', {
    title: 'Subscription Plans',
    user: req.user?.name || 'Admin',
    plans,
    query,
    page,
    limit,
    total,
  });
});

// Purchases (IAP) – from Purchase model (app store revenue)
router.get('/purchases', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10;
  const skip = (page - 1) * limit;
  const query = req.query.q?.trim() || '';

  // Separate pagination param (ppage) so paging one table doesn't move the other.
  const pPage = parseInt(req.query.ppage) || 1;
  const pLimit = 10;
  const pSkip = (pPage - 1) * pLimit;

  const pipeline = [
    { $sort: { purchase_date: -1 } },
    {
      $lookup: {
        from: 'users',
        localField: 'user',
        foreignField: '_id',
        as: 'userDoc',
      },
    },
    { $unwind: { path: '$userDoc', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'subscriptionplans',
        localField: 'plan_id',
        foreignField: '_id',
        as: 'planDoc',
      },
    },
    { $unwind: { path: '$planDoc', preserveNullAndEmptyArrays: true } },
    ...(query
      ? [
        {
          $match: {
            $or: [
              { product_identifier: { $regex: escapeRegex(query), $options: 'i' } },
              { 'planDoc.name': { $regex: escapeRegex(query), $options: 'i' } },
              { 'userDoc.name': { $regex: escapeRegex(query), $options: 'i' } },
              { 'userDoc.email': { $regex: escapeRegex(query), $options: 'i' } },
            ],
          },
        },
      ]
      : []),
    { $skip: skip },
    { $limit: limit },
    {
      $project: {
        _id: 1,
        user: 1,
        userDoc: { _id: 1, name: 1, email: 1 },
        plan_id: 1,
        planDoc: { _id: 1, name: 1, hashrate: 1, unit: 1, duration: 1 },
        product_identifier: 1,
        price_paid: 1,
        currency: 1,
        purchase_date: 1,
        status: 1,
        existing_hashpower: 1,
        updated_hashpower: 1,
      },
    },
  ];

  const countPipeline = [
    {
      $lookup: {
        from: 'users',
        localField: 'user',
        foreignField: '_id',
        as: 'userDoc',
      },
    },
    { $unwind: { path: '$userDoc', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'subscriptionplans',
        localField: 'plan_id',
        foreignField: '_id',
        as: 'planDoc',
      },
    },
    { $unwind: { path: '$planDoc', preserveNullAndEmptyArrays: true } },
    ...(query
      ? [
        {
          $match: {
            $or: [
              { product_identifier: { $regex: escapeRegex(query), $options: 'i' } },
              { 'planDoc.name': { $regex: escapeRegex(query), $options: 'i' } },
              { 'userDoc.name': { $regex: escapeRegex(query), $options: 'i' } },
              { 'userDoc.email': { $regex: escapeRegex(query), $options: 'i' } },
            ],
          },
        },
      ]
      : []),
    { $count: 'total' },
  ];

  // Super Privileges purchases live in a separate collection (AdMultiplierPrivilege,
  // not Purchase) since they aren't tied to a SubscriptionPlan/hashpower purchase --
  // they never showed up here before because this route only ever queried Purchase.
  // `user` on that model is stored as a plain String, not ObjectId, so it needs an
  // explicit $convert before it can $lookup against users._id.
  const privilegePipeline = [
    { $sort: { purchase_date: -1 } },
    { $skip: pSkip },
    { $limit: pLimit },
    {
      $addFields: {
        userObjId: { $convert: { input: '$user', to: 'objectId', onError: null, onNull: null } },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: 'userObjId',
        foreignField: '_id',
        as: 'userDoc',
      },
    },
    { $unwind: { path: '$userDoc', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 1,
        userName: { $ifNull: ['$userDoc.name', { $ifNull: ['$userDoc.email', '$user'] }] },
        userEmail: { $ifNull: ['$userDoc.email', '-'] },
        tier: 1,
        multiplier: 1,
        product_identifier: 1,
        price_paid: 1,
        currency: 1,
        purchase_date: 1,
        expires_at: 1,
        status: 1,
      },
    },
  ];

  const TIER_LABELS = { '5000pct': '+5000%', '10000pct': '+10000%' };

  const [purchases, countResult, privilegePurchasesRaw, privilegeTotal] = await Promise.all([
    Purchase.aggregate(pipeline),
    Purchase.aggregate(countPipeline),
    AdMultiplierPrivilege.aggregate(privilegePipeline),
    AdMultiplierPrivilege.countDocuments(),
  ]);
  const total = countResult[0]?.total || 0;
  const privilegePurchases = privilegePurchasesRaw.map((p) => ({
    ...p,
    tierLabel: TIER_LABELS[p.tier] || p.tier,
  }));

  const purchasesForView = purchases.map((p) => ({
    _id: p._id,
    userName: p.userDoc?.name ?? p.userDoc?.email ?? String(p.user ?? '-'),
    userEmail: p.userDoc?.email ?? '-',
    planName: p.planDoc?.name ?? '-',
    hashrate: p.planDoc ? `${p.planDoc.hashrate ?? '-'} ${p.planDoc.unit ?? 'Gh/s'}` : '-',
    duration: p.planDoc?.duration ?? '-',
    product_identifier: p.product_identifier ?? '-',
    price_paid: p.price_paid,
    currency: p.currency ?? 'USD',
    purchase_date: p.purchase_date,
    status: p.status ?? '-',
    existing_hashpower: p.existing_hashpower,
    updated_hashpower: p.updated_hashpower,
  }));

  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ purchases: purchasesForView, total, privilegePurchases, privilegeTotal });
  }

  res.render('purchases', {
    title: 'Purchases',
    user: req.session?.adminUser || 'Admin',
    purchases: purchasesForView,
    query,
    page,
    limit,
    total,
    privilegePurchases,
    privilegePage: pPage,
    privilegeLimit: pLimit,
    privilegeTotal,
  });
});

router.get('/usersubscriptions', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10;
  const skip = (page - 1) * limit;
  const query = req.query.q?.trim() || '';

  const UserSubsCollection = mongoose.connection.db.collection('userplans');

  // filter for plan name, user email, or user name (after lookup user is in userDoc)
  const matchStage = query
    ? {
      $or: [
        { plan_id: { $regex: escapeRegex(query), $options: 'i' } },
        { 'plan.name': { $regex: escapeRegex(query), $options: 'i' } },
        { 'user.email': { $regex: escapeRegex(query), $options: 'i' } },
        { 'user.name': { $regex: escapeRegex(query), $options: 'i' } },
      ],
    }
    : {};

  const pipeline = [
    // join with subscriptionplans (plan_id string <-> subscriptionplans.id string)
    {
      $lookup: {
        from: 'subscriptionplans',
        localField: 'plan_id',
        foreignField: 'id',
        as: 'plan',
      },
    },
    { $unwind: { path: '$plan', preserveNullAndEmptyArrays: true } },

    // join with users: support both string and ObjectId _id
    {
      $lookup: {
        from: 'users',
        let: { userId: '$user' },
        pipeline: [
          {
            $match: {
              $expr: {
                $or: [
                  { $eq: ['$_id', '$$userId'] },
                  { $eq: [{ $toString: '$_id' }, { $ifNull: ['$$userId', ''] }] },
                ],
              },
            },
          },
          { $project: { _id: 1, name: 1, email: 1 } },
        ],
        as: 'userDoc',
      },
    },
    {
      $addFields: {
        user: { $arrayElemAt: ['$userDoc', 0] },
      },
    },
    { $match: matchStage },
    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $project: {
        _id: 1,
        user: 1,
        crypto: 1,
        chain: 1,
        amount: 1,
        amount_crypto: 1,
        hashrate: 1,
        paid: 1,
        plan: 1,
        createdAt: 1,
      },
    },
  ];

  const UserSubs = await UserSubsCollection.aggregate(pipeline).toArray();

  // count total
  const totalPipeline = [
    {
      $lookup: {
        from: 'subscriptionplans',
        localField: 'plan_id',
        foreignField: 'id',
        as: 'plan',
      },
    },
    { $unwind: { path: '$plan', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'users',
        let: { userId: '$user' },
        pipeline: [
          {
            $match: {
              $expr: {
                $or: [
                  { $eq: ['$_id', '$$userId'] },
                  { $eq: [{ $toString: '$_id' }, { $ifNull: ['$$userId', ''] }] },
                ],
              },
            },
          },
        ],
        as: 'userDoc',
      },
    },
    { $addFields: { user: { $arrayElemAt: ['$userDoc', 0] } } },
    { $match: matchStage },
    { $count: 'total' },
  ];

  const totalResult = await UserSubsCollection.aggregate(totalPipeline).toArray();
  const total = totalResult[0]?.total || 0;

  if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ UserSubs, total });
  }

  res.render('usersubscriptions', {
    title: 'User Subscriptions',
    user: req.session?.adminUser || 'Admin',
    UserSubs,
    query,
    page,
    limit,
    total,
  });
});

// Users management
router.get('/users', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10;
  const skip = (page - 1) * limit;
  const searchQuery = req.query.q?.trim() || '';
  const rangeAll = req.query.range === 'all';
  const filterStart = clampToToday(req.query.startDate || '');
  const filterEnd = clampToToday(req.query.endDate || '');

  const usersCollection = mongoose.connection.db.collection('users');

  const filter = searchQuery
    ? {
      $or: [
        { name: { $regex: escapeRegex(searchQuery), $options: 'i' } },
        { email: { $regex: escapeRegex(searchQuery), $options: 'i' } }
      ]
    }
    : {};

  // Date range filter on signup date (createdAt). Defaults to all time when
  // no dates are given and range=all wasn't explicitly requested either --
  // there's no reason to silently narrow the list without the admin asking.
  if (!rangeAll && (filterStart || filterEnd)) {
    const createdAt = {};
    if (filterStart) createdAt.$gte = new Date(filterStart + 'T00:00:00.000Z');
    if (filterEnd) createdAt.$lte = new Date(filterEnd + 'T23:59:59.999Z');
    filter.createdAt = createdAt;
  }

  // Total users overall (unaffected by search/date filters) for the "X of Y total" label.
  const allTimeTotal = await usersCollection.countDocuments({});

  const [users, total] = await Promise.all([
    usersCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    usersCollection.countDocuments(filter)
  ]);

  const totalPages = Math.ceil(total / limit);

  // Enrich users with balance (total BTC, deposit BTC), referral count, and total referral rewards
  const userIds = users.map((u) => String(u._id));
  const referralCodes = [...new Set(users.map((u) => u.referralCode).filter(Boolean))];
  const referralCodesLower = referralCodes.map((c) => String(c).toLowerCase());

  const [balanceDocs, referralCounts, referralRewardDocs] = await Promise.all([
    Balance.find({ user: { $in: userIds } }).lean(),
    referralCodesLower.length > 0
      ? usersCollection
        .aggregate([
          { $addFields: { referralUsedLower: { $toLower: { $ifNull: ['$referralUsed', ''] } } } },
          { $match: { referralUsedLower: { $in: referralCodesLower } } },
          { $group: { _id: '$referralUsedLower', count: { $sum: 1 } } }
        ])
        .toArray()
      : [],
    ReferralRewardHistory.find({ parentUserId: { $in: userIds }, status: 'processed' }).lean()
  ]);

  const balanceByUser = Object.fromEntries(
    balanceDocs.map((b) => [
      b.user,
      {
        totalBtc: parseFloat(b.BTC?.toString() || '0') + parseFloat(b.BTC_DEPOSIT?.toString() || '0'),
        depositBtc: parseFloat(b.BTC_DEPOSIT?.toString() || '0')
      }
    ])
  );
  const referralByCode = Object.fromEntries(
    referralCounts.map((r) => [r._id, r.count])
  );
  const totalReferralRewardsByUser = referralRewardDocs.reduce((acc, r) => {
    const pid = r.parentUserId;
    const amount = parseFloat(r.rewardAmount?.toString() || '0');
    acc[pid] = (acc[pid] || 0) + amount;
    return acc;
  }, {});

  const usersEnriched = users.map((u) => {
    const uid = String(u._id);
    const balance = balanceByUser[uid] || { totalBtc: 0, depositBtc: 0 };
    const referralCount = u.referralCode ? (referralByCode[String(u.referralCode).toLowerCase()] || 0) : 0;
    const totalReferralRewards = totalReferralRewardsByUser[uid] ?? 0;
    return {
      ...u,
      totalBtc: balance.totalBtc,
      depositBtc: balance.depositBtc,
      referralCount,
      totalReferralRewards
    };
  });

  // If AJAX request, return JSON
  if (req.xhr) {
    return res.json({ users: usersEnriched, page, totalPages, total, allTimeTotal });
  }

  // Full page render
  res.render('users', {
    title: 'Users',
    user: req.user?.name || 'Admin',
    users: usersEnriched,
    page,
    limit,
    totalPages,
    total,
    allTimeTotal,
    searchQuery,
    filterStart,
    filterEnd,
    rangeAll
  });
});

// Help route
router.get('/help', requireAuth, async (req, res) => {
  try {
    const query = req.query.q || '';
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    const ticketsCollection = mongoose.connection.db.collection('supporttickets');

    const filter = query
      ? {
        $or: [
          { name: { $regex: escapeRegex(query), $options: 'i' } },
          { email: { $regex: escapeRegex(query), $options: 'i' } },
          { message: { $regex: escapeRegex(query), $options: 'i' } },
        ],
      }
      : {};

    const tickets = await ticketsCollection
      .find(filter)
      .sort({ _id: -1 }) // latest first
      .skip(skip)
      .limit(limit)
      .toArray();

    if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.json({ tickets });
    }

    // Initial full page render
    res.render('help', {
      title: 'Support Tickets',
      user: req.user?.name || 'Admin',
      tickets,
      searchQuery: query,
      page,
      limit,
    });
  } catch (error) {
    console.error('Error loading help tickets:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Deposit route
router.get('/deposit', requireAuth, (req, res) => {
  res.render('deposit', {
    title: 'Deposit Transactions',
    user: req.session.adminUser
  });
});

// Withdraw route
router.get('/withdraw', requireAuth, (req, res) => {
  res.render('withdraw', {
    title: 'Withdrawal Transactions',
    user: req.session.adminUser
  });
});

// Wallet route
router.get('/wallet', requireAuth, (req, res) => {
  res.render('wallet', {
    title: 'Wallet',
    user: req.session.adminUser
  });
});

// Profile route – use logged-in admin's username
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const username = req.session.adminUser || req.session.adminUserData?.username;
    if (!username) {
      return res.redirect('/admin/login');
    }

    let webUser = await WebUsers.findOne({ username }).lean();

    if (!webUser) {
      // Create profile for this admin if missing (e.g. first time)
      await WebUsers.findOneAndUpdate(
        { username },
        {
          $setOnInsert: {
            username,
            firstname: username,
            lastname: '',
            orgname: '',
            location: '',
            email: '',
            phone: '',
          },
        },
        { upsert: true, new: true }
      );
      webUser = await WebUsers.findOne({ username }).lean();
    }

    const successMessage = req.session.successMessage || null;
    const errorMessage = req.session.errorMessage || null;
    req.session.successMessage = null;
    req.session.errorMessage = null;

    res.render('profile', {
      title: 'Profile',
      user: username,
      webUser: webUser || {},
      successMessage,
      errorMessage,
    });
  } catch (err) {
    console.error('Error fetching profile:', err);
    res.status(500).send('Internal Server Error');
  }
});

// Settings route – load withdrawal limits and AdMob status from DB
router.get('/settings', requireAuth, async (req, res) => {
  try {
    const [withdrawalLimits, admobConfigured, versionPolicy] = await Promise.all([
      getWithdrawalLimits(),
      isAdMobConfigured(),
      getVersionPolicy(),
    ]);
    const settingsMessage = req.session.settingsMessage || null;
    const settingsError = req.session.settingsError || null;
    req.session.settingsMessage = null;
    req.session.settingsError = null;

    const adminBaseUrl =
      process.env.ADMIN_BASE_URL ||
      (process.env.ADMIN_PORT ? `http://localhost:${process.env.ADMIN_PORT}` : 'http://localhost:3001');
    const admobAuthUrl =
      process.env.ADMOB_CLIENT_ID && adminBaseUrl
        ? `${adminBaseUrl}/admin/admob/auth`
        : null;

    const admobQuerySuccess = req.query.admob === 'connected';
    const admobQueryError = typeof req.query.admob_error === 'string' ? decodeURIComponent(req.query.admob_error) : null;

    res.render('settings', {
      title: 'Settings',
      user: req.session.adminUser,
      withdrawalMinBtc: withdrawalLimits.minBtc,
      withdrawalMaxBtc: withdrawalLimits.maxBtc,
      settingsMessage: settingsMessage || (admobQuerySuccess ? 'AdMob connected. Dashboard will fetch revenue.' : null),
      settingsError: settingsError || admobQueryError,
      admobConfigured,
      admobAuthUrl,
      versionPolicy,
    });
  } catch (err) {
    console.error('Error loading settings:', err);
    res.render('settings', {
      title: 'Settings',
      user: req.session.adminUser,
      withdrawalMinBtc: 0.0005,
      withdrawalMaxBtc: 0.009,
      settingsMessage: null,
      settingsError: null,
      admobConfigured: false,
      admobAuthUrl: null,
      versionPolicy: await getVersionPolicy(),
    });
  }
});

// Save withdrawal limits (min/max BTC) from admin settings
router.post('/settings/withdrawal-limits', requireAuth, async (req, res) => {
  try {
    const { withdrawalMinBtc, withdrawalMaxBtc } = req.body;
    await setWithdrawalLimits(withdrawalMinBtc, withdrawalMaxBtc);
    req.session.settingsMessage = 'Withdrawal limits updated successfully.';
    return res.redirect('/admin/settings');
  } catch (err) {
    console.error('Error saving withdrawal limits:', err);
    req.session.settingsError = err.message || 'Failed to save withdrawal limits.';
    return res.redirect('/admin/settings');
  }
});

// Save app version update policy (admin controlled, DB-backed)
router.post('/settings/version-policy', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const policyInput = {
      enabled: body.versionPolicyEnabled,
      mode: body.versionPolicyMode,
      latestVersion: body.versionLatestVersion,
      minSupportedVersion: body.versionMinSupportedVersion,
      forceUpdateBelowVersion: body.versionForceBelowVersion,
      title: body.versionTitle,
      message: body.versionMessage,
      buttonText: body.versionButtonText,
      dismissible: body.versionDismissible,
      android: {
        mode: body.versionAndroidMode,
        latestVersion: body.versionAndroidLatestVersion,
        minSupportedVersion: body.versionAndroidMinSupportedVersion,
        forceUpdateBelowVersion: body.versionAndroidForceBelowVersion,
        storeUrl: body.versionAndroidStoreUrl,
        dismissible: body.versionAndroidDismissible,
      },
      ios: {
        mode: body.versionIosMode,
        latestVersion: body.versionIosLatestVersion,
        minSupportedVersion: body.versionIosMinSupportedVersion,
        forceUpdateBelowVersion: body.versionIosForceBelowVersion,
        storeUrl: body.versionIosStoreUrl,
        dismissible: body.versionIosDismissible,
      },
    };

    await setVersionPolicy(policyInput);
    req.session.settingsMessage = 'App version update policy saved successfully.';
    return res.redirect('/admin/settings');
  } catch (err) {
    console.error('Error saving version policy:', err);
    req.session.settingsError = err.message || 'Failed to save app version update policy.';
    return res.redirect('/admin/settings');
  }
});

// ─── AdMob OAuth (user auth, tokens in Settings) ─────────────────────────────
const ADMOB_SCOPES = [
  'https://www.googleapis.com/auth/admob.report',
  'https://www.googleapis.com/auth/admob.readonly',
].join(' ');

// Start OAuth: redirect to Google
router.get('/admob/auth', requireAuth, (req, res) => {
  const clientId = process.env.ADMOB_CLIENT_ID;
  const adminBaseUrl =
    process.env.ADMIN_BASE_URL ||
    (process.env.ADMIN_PORT ? `http://localhost:${process.env.ADMIN_PORT}` : 'http://localhost:3001');
  const redirectUri = `${adminBaseUrl}/admin/admob/callback`;
  if (!clientId) {
    req.session.settingsError = 'AdMob: ADMOB_CLIENT_ID not set in environment.';
    return res.redirect('/admin/settings');
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: ADMOB_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/auth?${params}`);
});

// OAuth callback: no requireAuth so redirect from Google always works (session can be lost)
router.get('/admob/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    const msg = encodeURIComponent(`AdMob authorization failed: ${error}`);
    if (req.session) req.session.settingsError = `AdMob authorization failed: ${error}`;
    return res.redirect(`/admin/settings?admob_error=${msg}`);
  }
  const clientId = process.env.ADMOB_CLIENT_ID;
  const clientSecret = process.env.ADMOB_CLIENT_SECRET;
  const adminBaseUrl =
    process.env.ADMIN_BASE_URL ||
    (process.env.ADMIN_PORT ? `http://localhost:${process.env.ADMIN_PORT}` : 'http://localhost:3001');
  const redirectUri = `${adminBaseUrl}/admin/admob/callback`;

  if (!clientId || !clientSecret) {
    const msg = encodeURIComponent('ADMOB_CLIENT_ID or ADMOB_CLIENT_SECRET not set.');
    if (req.session) req.session.settingsError = 'AdMob: ADMOB_CLIENT_ID or ADMOB_CLIENT_SECRET not set.';
    return res.redirect(`/admin/settings?admob_error=${msg}`);
  }
  if (!code) {
    return res.redirect('/admin/settings?admob_error=' + encodeURIComponent('No code received from Google.'));
  }
  try {
    const { data } = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const tokens = {
      refresh_token: data.refresh_token,
      access_token: data.access_token || '',
      expiry_date: data.expires_in ? Date.now() + data.expires_in * 1000 : 0,
    };
    if (!tokens.refresh_token) {
      const msg = encodeURIComponent('No refresh_token. Use "Connect with Google" again and grant consent.');
      if (req.session) req.session.settingsError = 'AdMob: No refresh_token received. Try "Connect with Google" again and ensure you grant consent.';
      return res.redirect(`/admin/settings?admob_error=${msg}`);
    }
    await saveAdMobTokens(tokens);
    if (req.session) req.session.settingsMessage = 'AdMob connected. Dashboard will use this to fetch revenue.';
    return res.redirect('/admin/settings?admob=connected');
  } catch (err) {
    const errMsg = err.response?.data?.error_description || JSON.stringify(err.response?.data || err.message);
    const msg = encodeURIComponent(errMsg);
    if (req.session) req.session.settingsError = `AdMob token exchange failed: ${errMsg}`;
    return res.redirect(`/admin/settings?admob_error=${msg}`);
  }
});

// AdMob status for debugging (what's configured, last error if any)
router.get('/admob/status', requireAuth, async (req, res) => {
  try {
    const { loadAdMobTokens } = await import('../helpers/admobAuth.js');
    const { fetchAdMobRevenue } = await import('../helpers/admobApi.js');
    const credsSet = !!(process.env.ADMOB_CLIENT_ID && process.env.ADMOB_CLIENT_SECRET);
    const accountSet = !!(process.env.ADMOB_ACCOUNT_ID && process.env.ADMOB_ACCOUNT_ID.trim());
    const tokens = await loadAdMobTokens();
    const hasTokens = !!(tokens?.refresh_token);
    let testRevenue = null;
    let testError = null;
    if (credsSet && hasTokens && accountSet) {
      try {
        testRevenue = await fetchAdMobRevenue();
      } catch (e) {
        testError = e.message || String(e);
      }
    }
    res.json({
      configured: credsSet && accountSet,
      hasTokens,
      hasCreds: credsSet,
      hasAccountId: accountSet,
      testRevenue,
      testError,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to get status' });
  }
});

// Paste tokens from Settings (e.g. from Google OAuth Playground)
router.post('/settings/admob-tokens', requireAuth, async (req, res) => {
  try {
    const { refresh_token: refreshToken, access_token: accessToken } = req.body;
    if (!refreshToken || typeof refreshToken !== 'string' || !refreshToken.trim()) {
      req.session.settingsError = 'Refresh token is required.';
      return res.redirect('/admin/settings');
    }
    const tokens = {
      refresh_token: refreshToken.trim(),
      access_token: (accessToken && String(accessToken).trim()) || '',
      expiry_date: accessToken ? Date.now() + 3500 * 1000 : 0,
    };
    await saveAdMobTokens(tokens);
    req.session.settingsMessage = 'AdMob tokens saved. The server will refresh the access token when needed.';
    return res.redirect('/admin/settings');
  } catch (err) {
    req.session.settingsError = err.message || 'Failed to save AdMob tokens.';
    return res.redirect('/admin/settings');
  }
});

// Transactions
router.get('/transactions', requireAuth, async (req, res) => {
  try {
    const response = await axios.get(`${process.env.BACKEND_API_URL}/admin/transactions`);
    const transactions = response.data.data;

    res.render('transactions', {
      title: 'Transactions',
      user: req.session.adminUser,
      transactions: transactions
    });
  } catch (error) {
    console.error('Transactions fetch error:', error.message);
    res.render('transactions', {
      title: 'Transactions',
      user: req.session.adminUser,
      transactions: [],
      error: 'Failed to fetch transactions'
    });
  }
});

// Support tickets
router.get('/support', requireAuth, async (req, res) => {
  try {
    const response = await axios.get(`${process.env.BACKEND_API_URL}/admin/support`);
    const tickets = response.data.data;

    res.render('support', {
      title: 'Support Tickets',
      user: req.session.adminUser,
      tickets: tickets
    });
  } catch (error) {
    console.error('Support fetch error:', error.message);
    res.render('support', {
      title: 'Support Tickets',
      user: req.session.adminUser,
      tickets: [],
      error: 'Failed to fetch support tickets'
    });
  }
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error:', err);
    }
    res.redirect('/admin/login');
  });
});

//FAQs
router.get('/faqs', requireAuth, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 10;
  const query = req.query.q || '';
  const skip = (page - 1) * limit;

  const faqsCollection = mongoose.connection.db.collection('faqs');

  const filter = query ? { name: { $regex: escapeRegex(query), $options: 'i' } } : {};
  const faqs = await faqsCollection.find(filter).sort({ date_created: -1 }).skip(skip).limit(limit).toArray();

  if (req.xhr) {
    return res.json({ faqs });
  }

  res.render('Faqs', { title: 'FAQs', faqs, searchQuery: query, page, limit, user: req.session.adminUser });
});

export default router;

router.get("/daily-rewards", requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    const rewards = await DailyReward.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const totalCount = await DailyReward.countDocuments();

    res.render("dailyRewards", {
      title: "Daily Rewards",
      user: req.session.adminUser,
      rewards,
      page,
      limit,
      totalCount,
    });
  } catch (err) {
    console.error("Error fetching rewards:", err);
    res.status(500).send("Server error");
  }
});

router.get("/withdrawals", requireAuth, async (req, res) => {
  try {
    const { page = 1, limit = 10, search = "" } = req.query;
    const searchTrim = typeof search === "string" ? search.trim() : "";
    const usersCollection = mongoose.connection.db.collection("users");

    const query = {};
    if (searchTrim) {
      const orConditions = [
        { userId: { $regex: escapeRegex(searchTrim), $options: "i" } },
        { status: { $regex: escapeRegex(searchTrim), $options: "i" } },
        { txHash: { $regex: escapeRegex(searchTrim), $options: "i" } }
      ];
      // Also search by user name or email
      const matchingUsers = await usersCollection
        .find({
          $or: [
            { name: { $regex: escapeRegex(searchTrim), $options: "i" } },
            { email: { $regex: escapeRegex(searchTrim), $options: "i" } }
          ]
        })
        .project({ _id: 1 })
        .toArray();
      const matchingUserIds = matchingUsers.map((u) => String(u._id));
      if (matchingUserIds.length > 0) {
        orConditions.push({ userId: { $in: matchingUserIds } });
      }
      query.$or = orConditions;
    }

    const withdrawals = await Withdrawal.find(query)
      .sort({ created_at: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean();

    const total = await Withdrawal.countDocuments(query);

    // Enrich with user name and email
    const userIds = [...new Set(withdrawals.map((w) => w.userId).filter(Boolean))];
    const userIdsForQuery = userIds.map((id) => {
      try {
        return mongoose.Types.ObjectId.isValid(id) && String(id).length === 24
          ? new mongoose.Types.ObjectId(id)
          : id;
      } catch (_) {
        return id;
      }
    });
    const userDocs = await usersCollection
      .find({ _id: { $in: userIdsForQuery } })
      .project({ _id: 1, name: 1, email: 1 })
      .toArray();
    const userMap = {};
    userDocs.forEach((u) => {
      const key = u._id instanceof mongoose.Types.ObjectId ? u._id.toString() : String(u._id);
      userMap[key] = { name: u.name || "-", email: u.email || "-" };
    });

    // Pull each involved user's CURRENT real balance so it can be shown
    // next to their withdrawal request — lets an admin spot at a glance
    // when a requested amount doesn't match what the user actually has,
    // instead of relying on manually noticing (as happened with the 1.4
    // BTC request).
    const balanceDocs = await Balance.find({ user: { $in: userIds } }).lean();
    const balanceMap = {};
    balanceDocs.forEach((b) => {
      const mined = parseFloat(b.BTC?.toString?.() ?? b.BTC ?? "0") || 0;
      const deposit = parseFloat(b.BTC_DEPOSIT?.toString?.() ?? b.BTC_DEPOSIT ?? "0") || 0;
      balanceMap[String(b.user)] = { mined, deposit, total: mined + deposit };
    });
    // Normalize Decimal128/BSON amounts to display strings (works with .lean())
    const toDecimalStr = (val) => {
      if (val == null || val === undefined) return null;
      if (typeof val === "string") return val;
      if (typeof val === "number" && !Number.isNaN(val)) return String(val);
      if (typeof val === "object" && val.$numberDecimal) return val.$numberDecimal;
      if (typeof val === "object" && typeof val.toString === "function") return val.toString();
      return null;
    };
    const formatBtc = (val) => {
      const s = toDecimalStr(val);
      if (s == null) return null;
      const n = parseFloat(s);
      if (Number.isNaN(n)) return null;
      return n.toFixed(16);
    };

    // Fetch BTC/USD price once for USDT→BTC conversion when defaultAmountNumeric is missing
    let btcUsdPrice = 0;
    try {
      btcUsdPrice = await getBtcUsdPriceCached(60_000);
    } catch (e) {
      console.warn("[Admin withdrawals] BTC price fetch failed:", e?.message ?? e);
    }

    const withdrawalsEnriched = withdrawals.map((w) => {
      const rawAmount = toDecimalStr(w.amountNumeric) ?? "0";
      const usdLike = ["USDT", "USDC", "USD"].includes(String(w.asset || "").toUpperCase());
      const amountStr = usdLike
        ? (parseFloat(rawAmount) || 0).toFixed(3)
        : rawAmount;

      let btcStr = formatBtc(w.defaultAmountNumeric);
      if (btcStr == null && btcUsdPrice > 0) {
        if (usdLike) {
          const usdAmount = parseFloat(rawAmount);
          if (Number.isFinite(usdAmount) && usdAmount >= 0) {
            btcStr = (usdAmount / btcUsdPrice).toFixed(16);
          }
        }
      }
      const userBalance = balanceMap[String(w.userId)] || null;
      const requestedBtcNum = btcStr != null ? parseFloat(btcStr) : null;
      // Flag when the requested BTC amount exceeds the user's real total
      // balance right now — a live, honest reading, not a guarantee: it
      // reflects balance AFTER this withdrawal's own reservation was
      // deducted (if any), and can drift if the user's balance changed
      // since the request was made. Always cross-check before approving.
      const exceedsBalance =
        userBalance != null && requestedBtcNum != null
          ? requestedBtcNum > userBalance.total + 1e-12
          : null;

      return {
        ...w,
        userName: userMap[w.userId]?.name ?? "-",
        userEmail: userMap[w.userId]?.email ?? "-",
        displayAmount: amountStr,
        displayBtc: btcStr,
        userBalanceBtc: userBalance != null ? userBalance.total.toFixed(16) : null,
        userBalanceMinedBtc: userBalance != null ? userBalance.mined.toFixed(16) : null,
        userBalanceDepositBtc: userBalance != null ? userBalance.deposit.toFixed(16) : null,
        exceedsBalance
      };
    });

    res.render("withdraw", {
      title: "Withdrawals",
      user: req.user,
      withdrawals: withdrawalsEnriched,
      page: Number(page),
      limit: Number(limit),
      total,
      search: searchTrim
    });
  } catch (err) {
    console.error("Error fetching withdrawals:", err);
    res.status(500).send("Server error");
  }
});

router.get('/fcm', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const searchQuery = req.query.q ? req.query.q.trim() : "";

    const query = {};
    if (searchQuery) {
      query.$or = [
        { token: { $regex: escapeRegex(searchQuery), $options: 'i' } },
        { user_id: { $regex: escapeRegex(searchQuery), $options: 'i' } }
      ];
    }

    const tokens = await FirebaseNotifications.find(query)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
    const totalTokens = await FirebaseNotifications.countDocuments();

    if (req.xhr) {
      // AJAX request -> return JSON
      return res.json({ tokens, page, limit });
    }

    // Normal request -> render EJS
    res.render('fcm_tokens', {
      title: 'Firebase Notifications',
      user: req.session?.adminUser || 'Admin',
      tokens,
      page,
      limit,
      searchQuery,
      totalTokens
    });
  } catch (err) {
    console.error('Error fetching FirebaseNotifications:', err);
    res.status(500).send('Server Error');
  }
});

/**
 * Send a custom push notification to a single user (by their Mongo user_id).
 * Body: { user_id, title, body }
 */
router.post('/notifications/send', requireAuth, async (req, res) => {
  try {
    const { user_id, title, body } = req.body;

    if (!user_id || !title || !body) {
      return res.status(400).json({ success: false, message: 'user_id, title and body are required' });
    }

    const result = await sendCustomNotification(user_id, title, body, {
      type: 'admin_custom',
      action: 'open_home',
    });

    if (result.success) {
      return res.json({ success: true, message: 'Notification sent.' });
    }
    return res.status(422).json({
      success: false,
      message: result.reason || result.error || 'Failed to send notification',
    });
  } catch (err) {
    console.error('Error sending admin notification:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/**
 * Broadcast a custom push notification to every user with a registered FCM token.
 * Body: { title, body }
 */
router.post('/notifications/send-all', requireAuth, async (req, res) => {
  try {
    const { title, body } = req.body;

    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'title and body are required' });
    }

    const userIds = await FirebaseNotifications.distinct('user_id');

    if (userIds.length === 0) {
      return res.status(422).json({ success: false, message: 'No registered devices to notify.' });
    }

    // Sending thousands of individual pushes can take well over a minute --
    // longer than nginx's proxy read timeout. Respond immediately and let the
    // broadcast run in the background instead of making the admin's browser
    // (and nginx) wait on it; final counts land in the server log.
    res.json({ success: true, queued: userIds.length });

    sendBulkNotifications(userIds, {
      title,
      body,
      data: { type: 'admin_broadcast', action: 'open_home' },
    }).catch(err => console.error('Error in background broadcast:', err));
    return;
  } catch (err) {
    console.error('Error broadcasting admin notification:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/delete_requests', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;
    const query = req.query.q ? req.query.q.trim() : '';

    // Match stage for email search
    const matchStage = query
      ? { 'user.email': { $regex: escapeRegex(query), $options: 'i' } }
      : {};

    // Aggregation pipeline
    const pipeline = [
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $match: matchStage },
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
      {
        $project: {
          _id: 1,
          user: { _id: 1, email: 1 },
          reason: 1,
          createdAt: 1,
        },
      },
    ];

    // Run query on DeleteRequests model
    const deleteRequests = await DeleteRequests.aggregate(pipeline);

    // Total count
    const totalPipeline = [
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
      { $match: matchStage },
      { $count: 'total' },
    ];

    const totalResult = await DeleteRequests.aggregate(totalPipeline);
    const total = totalResult[0]?.total || 0;

    // Handle AJAX requests
    if (req.headers['x-requested-with'] === 'XMLHttpRequest') {
      return res.json({ deleteRequests, total });
    }

    // Render EJS page
    res.render('deleterequests', {
      title: 'Delete Requests',
      user: req.user ? req.user.name : 'Admin',
      deleteRequests,
      query,
      page,
      limit,
      total,
    });
  } catch (err) {
    console.error('Error fetching delete requests:', err);
    res.status(500).send('Internal Server Error');
  }
});

// History shell — renders instantly with no DB queries; data loaded via /history/api
router.get('/history', requireAuth, (req, res) => {
  res.render('history', { title: 'History', user: req.session.adminUser });
});

// History JSON API — fast two-step: index-driven find first, then batch user lookup on result set only
router.get('/history/api', requireAuth, async (req, res) => {
  const tab = req.query.tab || 'streak';
  const gameType = req.query.gameType || 'trading';
  const miningType = req.query.miningType || 'sessions';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const search = (req.query.q || '').trim();

  // Raw access to the 'users' collection (Firebase/mobile users, no Mongoose model needed)
  const usersCol = mongoose.connection.db.collection('users');

  // Fetch name+email for a small set of string user IDs (called after pagination, not before)
  async function batchUsers(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return {};
    const oids = unique.flatMap(id => { try { return [new mongoose.Types.ObjectId(id)]; } catch { return []; } });
    const docs = await usersCol.find({ _id: { $in: oids } }, { projection: { name: 1, email: 1 } }).toArray();
    const map = {};
    docs.forEach(u => { map[u._id.toString()] = { name: u.name, email: u.email }; });
    return map;
  }

  // For search: get matching user IDs from the users collection first
  async function searchUserIds(q) {
    const docs = await usersCol.find(
      { $or: [{ name: { $regex: escapeRegex(q), $options: 'i' } }, { email: { $regex: escapeRegex(q), $options: 'i' } }] },
      { projection: { _id: 1 } }
    ).limit(500).toArray();
    return docs.map(u => u._id.toString());
  }

  try {
    let records = [], hasMore = false;

    if (tab === 'streak') {
      let filter = {};
      if (search) {
        const ids = await searchUserIds(search);
        if (!ids.length) return res.json({ records: [], hasMore: false, page, limit });
        filter = { user: { $in: ids } };
      }
      const rows = await UserMining.find(filter)
        .sort({ streakDays: -1 }).skip(skip).limit(limit + 1)
        .select('user streakDays streakLastDate streakClaimedMilestones updatedAt').lean();
      hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const umap = await batchUsers(rows.map(r => r.user));
      records = rows.map(r => {
        const u = umap[r.user] || {};
        return {
          userName: u.name, userEmail: u.email, streakDays: r.streakDays,
          streakLastDate: r.streakLastDate, streakClaimedMilestones: r.streakClaimedMilestones, updatedAt: r.updatedAt
        };
      });

    } else if (tab === 'game') {
      const fieldName = gameType === 'spin' ? 'spinHistory' : gameType === 'memory' ? 'memoryMatchHistory' : 'tradingHistory';
      const sortField = gameType === 'trading' ? `${fieldName}.earnedAt` : `${fieldName}.ts`;
      const matchFilter = { [`${fieldName}.0`]: { $exists: true } };
      if (search) {
        const ids = await searchUserIds(search);
        if (!ids.length) return res.json({ records: [], hasMore: false, page, limit });
        matchFilter.user = { $in: ids };
      }
      // Aggregation required for unwind, but no $lookup in the pipeline
      const rows = await UserMining.aggregate([
        { $match: matchFilter },
        { $unwind: `$${fieldName}` },
        { $sort: { [sortField]: -1 } },
        { $skip: skip },
        { $limit: limit + 1 },
        { $project: { user: 1, [fieldName]: 1 } },
      ]);
      hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const umap = await batchUsers(rows.map(r => r.user));
      records = rows.map(r => {
        const u = umap[r.user] || {};
        return { userName: u.name, userEmail: u.email, ...r[fieldName] };
      });

    } else if (tab === 'mining') {
      if (miningType === 'balance') {
        let filter = {};
        if (search) {
          const ids = await searchUserIds(search);
          if (!ids.length) return res.json({ records: [], hasMore: false, page, limit });
          filter = { user: { $in: ids } };
        }
        const rows = await BalanceHistory.find(filter)
          .sort({ date: -1 }).skip(skip).limit(limit + 1)
          .select('user date balances').lean();
        hasMore = rows.length > limit;
        if (hasMore) rows.pop();
        const umap = await batchUsers(rows.map(r => r.user));
        const toNum = v => v != null ? parseFloat(v.toString()) : null;
        records = rows.map(r => {
          const u = umap[r.user] || {};
          return {
            userName: u.name, userEmail: u.email, date: r.date,
            BTC: toNum(r.balances?.BTC)
          };
        });

      } else {
        let filter = {};
        if (search) {
          const ids = await searchUserIds(search);
          if (!ids.length) return res.json({ records: [], hasMore: false, page, limit });
          filter = { user_id: { $in: ids } };
        }
        const rows = await MiningSession.find(filter)
          .sort({ createdAt: -1 }).skip(skip).limit(limit + 1)
          .select('user_id start_time end_time hash_power ads_watched status').lean();
        hasMore = rows.length > limit;
        if (hasMore) rows.pop();
        const umap = await batchUsers(rows.map(r => r.user_id));
        records = rows.map(r => {
          const u = umap[r.user_id] || {};
          return {
            userName: u.name, userEmail: u.email, start_time: r.start_time,
            end_time: r.end_time, hash_power: r.hash_power, ads_watched: r.ads_watched, status: r.status
          };
        });
      }
    }

    return res.json({ records, hasMore, page, limit });
  } catch (err) {
    console.error('History API error:', err);
    return res.status(500).json({ error: 'Failed to fetch history data' });
  }
});
