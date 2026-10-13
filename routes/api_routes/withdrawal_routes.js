// routes/withdrawals/index.js
import express from "express";
import Withdrawal from "../../models/Withdrawal.js";
import Balance from "../../models/Balance.js";
import mongoose from "mongoose";
import Client from "lightning-client";
import axios from "axios";
import dotenv from 'dotenv';
import { getEffectiveWithdrawalLimits, belowMinimumMessage, SPEED_MIN_USDT } from "../../helpers/withdrawalLimits.js";
import { getBtcUsdPriceCached } from "../../helpers/btcPrice.js";
import { mobileAppGuard } from "../../middleware/mobileAppGuard.js";
import { requireAdminAuth } from "../../middleware/requireAdminAuth.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import util from "util";
import { escapeRegex } from "../../helpers/escapeRegex.js";

dotenv.config();

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const withdrawalLogDir = path.resolve(__dirname, "../../logs/withdrawals");

function sanitizeForLog(value) {
  if (value === undefined) return null;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof mongoose.Types.Decimal128) {
    return value.toString();
  }
  return value;
}

function safeJsonStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(
    value,
    (key, currentValue) => {
      const sanitized = sanitizeForLog(currentValue);
      if (sanitized && typeof sanitized === "object") {
        if (seen.has(sanitized)) {
          return "[Circular]";
        }
        seen.add(sanitized);
      }
      return sanitized;
    }
  );
}

function writeWithdrawalLog(fileName, event, data = {}) {
  try {
    if (!fs.existsSync(withdrawalLogDir)) {
      fs.mkdirSync(withdrawalLogDir, { recursive: true });
    }
    const filePath = path.join(withdrawalLogDir, fileName);
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      ...data,
    };
    let serializedEntry;
    try {
      serializedEntry = safeJsonStringify(entry);
    } catch (serializationError) {
      serializedEntry = JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "log_serialization_fallback",
        originalEvent: event,
        serializationError: sanitizeForLog(serializationError),
        dataPreview: util.inspect(data, { depth: 3, breakLength: 120 }),
      });
    }
    fs.appendFileSync(filePath, serializedEntry + "\n", "utf8");
  } catch (logErr) {
    console.error(`Withdrawal log write failed (${fileName}):`, logErr);
  }
}

function logWithdrawPost(event, data = {}) {
  writeWithdrawalLog("withdraw-post.txt", event, data);
}

function logWithdrawApprove(event, data = {}) {
  writeWithdrawalLog("withdraw-approve.txt", event, data);
}

function logWithdrawReject(event, data = {}) {
  writeWithdrawalLog("withdraw-reject.txt", event, data);
}

function requireWithdrawalAccess(req, res, next) {
  if (req.session?.isLoggedIn) {
    req.mobileAccessMeta = {
      source: "admin-session",
      mobileHeadersValid: false,
    };
    return next();
  }
  const appId = String(req.headers['x-app-id'] || '').trim().toLowerCase();
  const platform = String(req.headers['x-app-platform'] || '').trim().toLowerCase();
  const appVersion = String(req.headers['x-app-version'] || '').trim();
  const deviceId = String(req.headers['x-device-id'] || '').trim();
  const mobileClient = String(req.headers['x-mobile-client'] || '').trim().toLowerCase();
  const allowedAppIds = (process.env.MOBILE_ALLOWED_APP_IDS || 'bitplay-mobile')
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  const validPlatform = platform === 'android' || platform === 'ios';
  const validAppId = allowedAppIds.includes(appId);
  const validDeviceId = deviceId.length >= 8;
  const validVersion = appVersion.length > 0;
  const validMobileClient = mobileClient === 'true';
  const mobileHeadersValid = validAppId && validPlatform && validVersion && validDeviceId && validMobileClient;
  req.mobileAccessMeta = {
    source: "mobile-headers",
    mobileHeadersValid,
    appId,
    platform,
    appVersion,
    deviceId,
    mobileClient,
    validation: {
      validAppId,
      validPlatform,
      validVersion,
      validDeviceId,
      validMobileClient,
    },
  };

  if (!mobileHeadersValid) {
    return res.status(403).json({
      success: false,
      message: 'Forbidden: mobile app access required.',
      code: 'MOBILE_APP_REQUIRED',
    });
  }
  return mobileAppGuard(req, res, next);
}

// Use a single key everywhere (set in your env file)

const SPEED_API_KEY = process.env.SPEED_API_KEY;

// Lightning client config
const rpcPath = process.env.LIGHTNING_RPC_PATH || "/home/pi/.lightning/bitcoin";

let client = null;
if (fs.existsSync(rpcPath)) {
  client = new Client(rpcPath);
} else {
  console.warn(`⚠️ Lightning client not initialized: RPC socket not found at ${rpcPath}`);
}

function isValidSpeedLN(address) {
  const regex = /^[a-zA-Z0-9_-]+@speed\.app$/;
  return regex.test(address);
}

/**
 * Helper: build Basic auth header from Speed API key
 */
function getSpeedAuthHeader() {
  return "Basic " + Buffer.from(SPEED_API_KEY + ":").toString("base64");
}

/**
 * True when creating a withdrawal failed because another request for the
 * same user was being created at the same moment: the one_pending_per_user
 * unique index (duplicate key, 11000) or, inside the Lightning route's
 * transaction, a write conflict with that concurrent transaction (112 /
 * TransientTransactionError).
 */
function isConcurrentWithdrawalError(err) {
  if (!err) return false;
  if (err.code === 11000 || err.code === 112) return true;
  const labels = err.errorLabels || err.errorLabelSet;
  if (labels && (Array.isArray(labels) ? labels : [...labels]).includes("TransientTransactionError")) return true;
  return /E11000|WriteConflict/i.test(String(err.message || ""));
}

/** The same 409 the routes already return when a pending withdrawal exists. */
async function pendingConflict(res, userId, route) {
  const existing = await Withdrawal.findOne({ userId: String(userId), status: "PENDING" }).select("_id").lean().catch(() => null);
  console.warn(`[withdrawals] duplicate simultaneous request refused for user ${userId} (${route})`);
  return res.status(409).json({
    error: "You already have a pending withdrawal request. Please wait for it to be processed before creating a new one.",
    pendingWithdrawalId: existing?._id,
  });
}

/**
 * Helper function to safely deduct balance with transaction locks
 * @param {string} userId - User ID
 * @param {string|number} baseAmount - Amount to deduct from BTC_DEPOSIT (will be converted to string for precision)
 * @param {Object} [session] - Optional MongoDB session for transaction
 * @returns {Promise<Object>} Updated balance
 */
async function deductBTCDepositBalance(userId, baseAmount, session = null) {
  if (baseAmount === undefined || baseAmount === null || isNaN(baseAmount)) {
    throw new Error("baseAmount is required and must be a valid number");
  }
  const baseAmountStr = typeof baseAmount === 'string' ? baseAmount : baseAmount.toString();
  const negativeAmountStr = baseAmountStr.startsWith('-') ? baseAmountStr : '-' + baseAmountStr;

  const options = {
    new: true,
    runValidators: true,
  };
  if (session) options.session = session;

  const balance = await Balance.findOneAndUpdate(
    {
      user: userId,
      BTC_DEPOSIT: {
        $gte: mongoose.Types.Decimal128.fromString(baseAmountStr),
      },
    },
    {
      $inc: {
        BTC_DEPOSIT: mongoose.Types.Decimal128.fromString(negativeAmountStr),
      },
    },
    options
  );

  if (!balance) {
    throw new Error("Insufficient BTC_DEPOSIT balance or user not found");
  }

  return balance;
}

/**
 * Helper function to restore balance in case of failed withdrawal
 * @param {string} userId - User ID
 * @param {number} baseAmount - Amount to restore to BTC_DEPOSIT
 * @param {Object} session - MongoDB session for transaction
 * @returns {Promise<Object>} Updated balance
 */
async function restoreBTCDepositBalance(userId, baseAmount, session) {
  const balance = await Balance.findOneAndUpdate(
    { user: userId },
    {
      $inc: {
        BTC_DEPOSIT: mongoose.Types.Decimal128.fromString(baseAmount.toString()),
      },
    },
    {
      new: true,
      session,
      runValidators: true,
      upsert: false,
    }
  );

  if (!balance) {
    throw new Error("User balance not found for restoration");
  }

  return balance;
}

/**
 * GET all withdrawals (admin)
 * Supports pagination & search by userId or status
 */
router.get("/", requireAdminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 10, search = "" } = req.query;

    const query = {};
    if (search) {
      // Search by userId or status or txHash
      query.$or = [
        { userId: { $regex: escapeRegex(search), $options: "i" } },
        { status: { $regex: escapeRegex(search), $options: "i" } },
        { txHash: { $regex: escapeRegex(search), $options: "i" } },
      ];
    }

    const withdrawals = await Withdrawal.find(query)
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await Withdrawal.countDocuments(query);

    res.render("withdrawals/index", {
      title: "Withdrawals",
      user: req.user,
      withdrawals,
      page: Number(page),
      limit: Number(limit),
      total,
    });
  } catch (err) {
    console.error("Error fetching withdrawals:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET Speed wallet account info (which account is linked for sending money)
 * Returns mode, full API key, balance, and all available details for admin display.
 */
router.get("/speed-account", requireAdminAuth, async (req, res) => {
  try {
    const key = SPEED_API_KEY;
    if (!key || typeof key !== "string" || !key.trim()) {
      return res.json({
        configured: false,
        message: "No Speed API key configured (SPEED_API_KEY)",
      });
    }
    const trimmed = key.trim();
    const isLive = trimmed.startsWith("sk_live_");
    const isTest = trimmed.startsWith("sk_test_");
    const mode = isLive ? "live" : isTest ? "test" : "unknown";
    const mask = (s) => {
      if (s.length <= 12) return "****";
      return s.slice(0, 8) + "…" + s.slice(-4);
    };

    const payload = {
      configured: true,
      mode,
      modeLabel: mode === "live" ? "Live (production)" : mode === "test" ? "Test" : "Unknown",
      apiKeyMasked: mask(trimmed),
      hint: "Speed account used to send withdrawals. Manage at app.tryspeed.com → Developers → API Keys.",
    };

    // Fetch balance from Speed API
    try {
      const balanceRes = await axios.get("https://api.tryspeed.com/balances", {
        headers: { Authorization: getSpeedAuthHeader() },
      });
      if (balanceRes.data && balanceRes.data.available && Array.isArray(balanceRes.data.available)) {
        payload.balance = balanceRes.data.available;
        payload.balanceObject = balanceRes.data.object || null;
      } else {
        payload.balance = [];
        payload.balanceRaw = balanceRes.data;
      }
    } catch (err) {
      const errData = err.response?.data;
      payload.balance = [];
      payload.balanceError =
        (typeof errData === "object" && errData !== null && (errData.message || errData.error))
          ? (errData.message || errData.error)
          : err.message || "Failed to fetch balance";
    }

    return res.json(payload);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Failed to get Speed account info" });
  }
});

/**
 * GET withdrawal limits (min/max in BTC) for the app to validate and display.
 * The minimum is the dashboard value raised, when needed, to what Speed will
 * pay at the current BTC price (helpers/withdrawalLimits.js), so the app never
 * shows a minimum the payout provider then refuses.
 */
router.get("/limits", async (req, res) => {
  try {
    const { minBtc, maxBtc, adminMinBtc, speedMinBtc, raisedBySpeed } = await getEffectiveWithdrawalLimits();
    return res.json({ minBtc, maxBtc, adminMinBtc, speedMinBtc, raisedBySpeed });
  } catch (err) {
    console.error("Error fetching withdrawal limits:", err);
    return res.status(500).json({ error: err.message || "Failed to get withdrawal limits" });
  }
});

/**
 * GET withdrawals by userId (for user dashboard / mobile)
 */
router.get("/user/:userId", async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({
      userId: req.params.userId,
    }).sort({ created_at: -1 });
    res.json(withdrawals);
  } catch (err) {
    console.error("Error fetching user withdrawals:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST create new withdrawal (mobile app)
 * Status will be PENDING by default
 */
router.post("/", requireWithdrawalAccess, async (req, res) => {
  try {
    let { userId, asset, chain, toAddress, amountNumeric, amountBtc } = req.body;
    logWithdrawPost("request_received", {
      route: "POST /withdrawals",
      userId,
      toAddress,
      amountNumeric,
      amountBtc,
      mobileAccessMeta: req.mobileAccessMeta || null,
      ip: req.ip,
      method: req.method,
    });


    if (!userId || !toAddress || amountNumeric == null || amountNumeric === "") {
      return res.status(400).json({ error: "Missing required fields" });
    }
    if (amountBtc == null || amountBtc === "") {
      return res
        .status(400)
        .json({ error: "amountBtc is required (BTC amount to withdraw from BTC_DEPOSIT)." });
    }

    if (typeof toAddress !== "string" || !isValidSpeedLN(toAddress.trim())) {
      return res.status(400).json({ error: "Invalid withdrawal address. Use a valid Speed address (name@speed.app)." });
    }
    toAddress = toAddress.trim();

    const btcStr =
      typeof amountBtc === "object" && amountBtc !== null && amountBtc.toString
        ? amountBtc.toString()
        : String(amountBtc);
    const btcNum = Number(btcStr);
    if (!Number.isFinite(btcNum) || btcNum <= 0) {
      return res.status(400).json({ error: "Invalid withdrawal amount (BTC)." });
    }

    const limits = await getEffectiveWithdrawalLimits();
    const { minBtc, maxBtc } = limits;

    if (btcNum < minBtc) {
      return res.status(400).json({
        error: belowMinimumMessage(limits),
        minBtc,
        maxBtc,
      });
    }
    if (btcNum > maxBtc) {
      return res.status(400).json({
        error: `Withdrawal amount must not exceed ${maxBtc} BTC.`,
        minBtc,
        maxBtc,
      });
    }

    const balance = await Balance.findOne({ user: userId });
    if (!balance) {
      return res.status(400).json({ error: "Balance not found for user" });
    }

    const usersCollection = mongoose.connection.collection("users");
    const userIdString = String(userId || "");
    const userIdObjectId =
      mongoose.Types.ObjectId.isValid(userIdString) && userIdString.length === 24
        ? new mongoose.Types.ObjectId(userIdString)
        : null;
    const userDoc = await usersCollection.findOne(
      userIdObjectId
        ? { $or: [{ _id: userIdString }, { _id: userIdObjectId }] }
        : { _id: userIdString }
    );
    if (!userDoc) {
      return res.status(400).json({ error: "User not found" });
    }

    const minedBtc = parseFloat(balance.BTC?.toString() || "0");
    const depositBtc = parseFloat(balance.BTC_DEPOSIT?.toString() || "0");
    if (!Number.isFinite(minedBtc) || minedBtc <= 0) {
      return res.status(400).json({ error: "No mined BTC available for withdrawal." });
    }
    if (depositBtc + minedBtc + 1e-14 < btcNum) {
      return res.status(400).json({ error: "Insufficient balance: requested BTC is greater than your total balance" });
    }

    // Block if user already has a pending withdrawal
    const existingPending = await Withdrawal.findOne({ userId, status: "PENDING" });
    if (existingPending) {
      return res.status(409).json({
        error: "You already have a pending withdrawal request. Please wait for it to be processed before creating a new one.",
        pendingWithdrawalId: existingPending._id,
      });
    }

    // Force asset to USDT for all withdrawals
    asset = "USDT";
    chain = "USDT";

    // Speed pays nothing under 0.5 USDT. The BTC minimum above already covers
    // this at the current price; this is the safety net for an app that
    // converted at a stale price. The message names the BTC amount, which is
    // what the user typed.
    const amountNum =
      typeof amountNumeric === "object" && amountNumeric?.toString
        ? Number(amountNumeric.toString())
        : Number(amountNumeric);
    if (!Number.isFinite(amountNum) || amountNum < SPEED_MIN_USDT) {
      return res.status(400).json({
        error: `${belowMinimumMessage(limits)} The payout provider's minimum is ${SPEED_MIN_USDT} USDT.`,
        minBtc,
        maxBtc,
        minAmountUsdt: SPEED_MIN_USDT,
      });
    }

    const btcUsd = await getBtcUsdPriceCached(60_000);

    if (btcUsd > 0) {
      const depositUsdApprox = depositBtc * btcUsd;
      if (depositUsdApprox + 1e-6 < amountNum) {
        return res.status(400).json({
          error:
            "Insufficient balance: USDT/USD notional (amountNumeric) exceeds the value of your on-chain deposit at current rate",
          availableUsdtNotionalApprox: Math.floor(depositUsdApprox * 1e8) / 1e8,
          requestedUsdt: amountNum,
        });
      }
      const impliedUsd = btcNum * btcUsd;
      if (impliedUsd > 0) {
        const relDiff = Math.abs(amountNum - impliedUsd) / Math.max(impliedUsd, 1e-9);
        if (relDiff > 0.15) {
          return res.status(400).json({
            error:
              "amountNumeric and amountBtc are inconsistent: they must match the same withdrawal (within 15% of current BTC/USD)",
            impliedUsdtFromAmountBtc: impliedUsd,
            amountNumeric: amountNum,
          });
        }
      }
    }

    let withdrawal;
    try {
      withdrawal = await Withdrawal.create({
        userId,
        asset,
        chain,
        toAddress,
        amountNumeric,
        defaultAmountNumeric: mongoose.Types.Decimal128.fromString(btcNum.toFixed(16)),
        mobileHeadersValid: Boolean(req.mobileAccessMeta?.mobileHeadersValid),
        mobileAccessMeta: req.mobileAccessMeta || null,
      });
    } catch (createErr) {
      // A simultaneous request for the same user got in first (see the
      // one_pending_per_user index on the Withdrawal model).
      if (isConcurrentWithdrawalError(createErr)) {
        return pendingConflict(res, userId, "POST /withdrawals");
      }
      throw createErr;
    }


    logWithdrawPost("request_created_success", {
      route: "POST /withdrawals",
      userId,
      withdrawalId: withdrawal?._id,
      status: withdrawal?.status,
      toAddress,
      amountNumeric,
      amountBtc: btcNum,
    });
    res.status(201).json({
      message: "Withdrawal request created successfully",
      withdrawal,
    });
  } catch (err) {
    console.error("Error creating withdrawal:", err);
    logWithdrawPost("request_failed", {
      route: "POST /withdrawals",
      userId: req.body?.userId,
      toAddress: req.body?.toAddress,
      amountNumeric: req.body?.amountNumeric,
      amountBtc: req.body?.amountBtc,
      error: err,
    });
    res
      .status(400)
      .json({ error: err.message || "Failed to create withdrawal" });
  }
});

/**
 * PATCH approve withdrawal (admin)
 * Calls Speed /send afterwards to handle sending
 */
router.patch("/:id/approve", requireAdminAuth, async (req, res) => {
  // Set once this request holds the approval claim (see step 1).
  let claimedId = null;
  let paymentAttempted = false;
  // Every return that happens before Speed could have been paid must release
  // the claim, so the admin can try again.
  const releaseClaim = () =>
    claimedId == null
      ? Promise.resolve()
      : Withdrawal.updateOne(
          { _id: claimedId, status: "PENDING" },
          { $set: { approvalStartedAt: null, approvalStartedBy: null } }
        ).catch(e => console.error(`[approve] could not release approval claim on ${claimedId}:`, e.message));
  // Speed did not give a clear answer: the payment may or may not have gone
  // out. Keep the claim (no re-approval) and do not refund until an admin has
  // checked Speed; they can then reject (refunds) or mark it sent.
  const lockAsUnknown = (reason) =>
    claimedId == null
      ? Promise.resolve()
      : Withdrawal.updateOne(
          { _id: claimedId, status: "PENDING" },
          { $set: { approvalNote: `Outcome unknown: ${reason}. Check this payment at app.tryspeed.com before approving again or rejecting.` } }
        ).catch(e => console.error(`[approve] could not record unknown outcome on ${claimedId}:`, e.message));
  try {
    logWithdrawApprove("request_received", {
      route: "PATCH /withdrawals/:id/approve",
      withdrawalId: req.params.id,
      approvedBy: req.user?.id || "system",
      ip: req.ip,
      method: req.method,
    });
    // 1. Claim the withdrawal atomically. Only one approval can hold a PENDING
    // withdrawal at a time: a second, simultaneous approval (double click, two
    // admins) is refused here, before anything is deducted or paid. Reading it
    // and checking status separately let two approvals both pass and both pay.
    const approver = String(req.user?.id || req.session?.adminUser || "admin");
    const withdrawal = await Withdrawal.findOneAndUpdate(
      { _id: req.params.id, status: "PENDING", approvalStartedAt: null },
      { $set: { approvalStartedAt: new Date(), approvalStartedBy: approver, approvalNote: null } },
      { new: true }
    );
    if (!withdrawal) {
      const current = await Withdrawal.findById(req.params.id).lean();
      if (!current) {
        logWithdrawApprove("withdrawal_not_found", {
          route: "PATCH /withdrawals/:id/approve",
          withdrawalId: req.params.id,
        });
        return res.status(404).json({ error: "Withdrawal not found" });
      }
      if (current.status !== "PENDING") {
        logWithdrawApprove("invalid_status", {
          route: "PATCH /withdrawals/:id/approve",
          withdrawalId: req.params.id,
          status: current.status,
        });
        return res.status(400).json({
          error: `Cannot approve withdrawal with status: ${current.status}`,
        });
      }
      logWithdrawApprove("approval_already_in_progress", {
        route: "PATCH /withdrawals/:id/approve",
        withdrawalId: req.params.id,
        approvalStartedAt: current.approvalStartedAt,
        approvalStartedBy: current.approvalStartedBy,
      });
      return res.status(409).json({
        error: current.approvalNote
          || "This withdrawal is already being approved. Wait for that attempt to finish and reload the page.",
        approvalStartedAt: current.approvalStartedAt,
        approvalStartedBy: current.approvalStartedBy,
      });
    }

    claimedId = withdrawal._id;

    // Use dynamic values for Speed API payload
    const amount =
      typeof withdrawal.amountNumeric === "object" &&
        withdrawal.amountNumeric !== null &&
        withdrawal.amountNumeric.toString
        ? Number(withdrawal.amountNumeric.toString())
        : Number(withdrawal.amountNumeric);

    if (!amount || Number.isNaN(amount) || amount <= 0) {
      logWithdrawApprove("invalid_amount", {
        route: "PATCH /withdrawals/:id/approve",
        withdrawalId: req.params.id,
        amount,
      });
      await releaseClaim();
      return res.status(400).json({
        error: "Invalid withdrawal amount",
      });
    }

    // Speed API minimum: 0.5 USDT (50 USDT cents)
    if (withdrawal.asset === "USDT" && amount < SPEED_MIN_USDT) {
      logWithdrawApprove("speed_minimum_failed", {
        route: "PATCH /withdrawals/:id/approve",
        withdrawalId: req.params.id,
        asset: withdrawal.asset,
        amount,
        minimum: SPEED_MIN_USDT,
      });
      await releaseClaim();
      return res.status(400).json({
        error: `Withdrawal amount is below Speed minimum. Amount must be at least ${SPEED_MIN_USDT} USDT (got ${amount} USDT).`,
        minAmountUsdt: SPEED_MIN_USDT,
        amountUsdt: amount,
      });
    }

    // Speed API allows at most 8 decimal digits; avoid float precision (e.g. 0.058973399999999995)
    const amountForSpeed = parseFloat(Number(amount).toFixed(8));

    const dataspeed = JSON.stringify({
      amount: amountForSpeed,
      currency: withdrawal.asset,
      target_currency: withdrawal.asset,
      withdraw_method: "lightning",
      withdraw_request: withdrawal.toAddress,
      note: "Withdrawal approved from backend"
    });

    console.log("Speed API payload (approve):", dataspeed);

    const config = {
      method: "post",
      maxBodyLength: Infinity,
      url: "https://api.tryspeed.com/send",
      headers: {
        "Content-Type": "application/json",
        Authorization: getSpeedAuthHeader(),
      },
      data: dataspeed,
      // Bounded, so an approval never hangs with the claim held indefinitely.
      timeout: 60_000,
    };

    // 3. Deduct balance FIRST -- before calling Speed API so we never pay
    // without deducting. Withdrawals created via /create-speed-payment
    // already deduct balance (and set balanceDeducted: true) at creation
    // time -- if that route's own Speed auto-send failed and this is an
    // admin retry, skip deducting again here (would double-charge the
    // user for the same withdrawal). Otherwise (e.g. a withdrawal created
    // via plain POST /, which doesn't deduct at creation), deduct now.
    const btcAmountStr = (() => {
      const raw = withdrawal?.defaultAmountNumeric;
      if (raw == null) return null;
      const s = typeof raw === "object" && raw.toString ? raw.toString() : String(raw);
      return s === "undefined" || s === "null" || s === "" ? null : s;
    })();

    if (!withdrawal.balanceDeducted) {
      if (!btcAmountStr || isNaN(Number(btcAmountStr)) || Number(btcAmountStr) <= 0) {
        // Without a BTC amount nothing can be taken from the user's balance,
        // and paying anyway would be free money. This used to log a warning
        // and pay; now it refuses.
        logWithdrawApprove("refused_no_btc_amount", {
          route: "PATCH /withdrawals/:id/approve",
          withdrawalId: req.params.id,
          userId: withdrawal.userId,
          defaultAmountNumeric: String(withdrawal?.defaultAmountNumeric),
        });
        await releaseClaim();
        return res.status(400).json({
          error: "This withdrawal has no BTC amount recorded, so the user's balance cannot be deducted. Reject it and ask the user to request again.",
        });
      } else {
        try {
          await deductBTCDepositBalance(withdrawal.userId, btcAmountStr);
          withdrawal.balanceDeducted = true;
          await withdrawal.save();
          logWithdrawApprove("balance_deducted", {
            route: "PATCH /withdrawals/:id/approve",
            withdrawalId: req.params.id,
            userId: withdrawal.userId,
            btcAmount: btcAmountStr,
          });
        } catch (deductErr) {
          logWithdrawApprove("balance_deduction_failed_pre_send", {
            route: "PATCH /withdrawals/:id/approve",
            withdrawalId: req.params.id,
            userId: withdrawal.userId,
            error: deductErr,
          });
          await releaseClaim();
          return res.status(400).json({
            error: "Insufficient BTC deposit balance -- withdrawal cannot be approved.",
            details: deductErr.message,
          });
        }
      }
    } else {
      logWithdrawApprove("balance_deduction_skipped_already_deducted", {
        route: "PATCH /withdrawals/:id/approve",
        withdrawalId: req.params.id,
        userId: withdrawal.userId,
        btcAmount: btcAmountStr,
      });
    }

    // 4. Call Speed API after balance is safely reserved
    let responsespeed;
    try {
      paymentAttempted = true;
      responsespeed = await axios.request(config);
    } catch (apiError) {
      // No HTTP answer (timeout, connection reset): Speed may have paid.
      // Keep the claim and the deducted balance; an admin must check Speed.
      if (!apiError.response) {
        await lockAsUnknown(`Speed did not answer (${apiError.code || apiError.message})`);
        logWithdrawApprove("speed_outcome_unknown", {
          route: "PATCH /withdrawals/:id/approve",
          withdrawalId: req.params.id,
          userId: withdrawal.userId,
          message: apiError.message,
          code: apiError.code,
        });
        console.error(`[approve] Speed outcome UNKNOWN for withdrawal ${withdrawal._id}: ${apiError.message}`);
        return res.status(502).json({
          error: "Speed did not answer, so it is not known whether this payment was sent. The withdrawal is locked and the balance stays deducted. Check it at app.tryspeed.com, then mark it sent or reject it.",
          details: apiError.message,
        });
      }
      // Speed answered with an error: nothing was paid. Restore whatever
      // balance is reserved for this withdrawal (whether deducted just now or
      // already reserved from creation), then release the claim so the admin
      // can retry. Release only after the refund, or a retry could pay while
      // the balance still looks reserved and this refund then lands too.
      if (withdrawal.balanceDeducted && btcAmountStr) {
        try {
          await restoreBTCDepositBalance(withdrawal.userId, btcAmountStr);
          withdrawal.balanceDeducted = false;
          await withdrawal.save();
          logWithdrawApprove("balance_restored_after_speed_failure", {
            route: "PATCH /withdrawals/:id/approve",
            withdrawalId: req.params.id,
            userId: withdrawal.userId,
            btcAmount: btcAmountStr,
          });
        } catch (restoreErr) {
          console.error("[approve] CRITICAL: balance restore failed after Speed error:", restoreErr);
          logWithdrawApprove("balance_restore_failed", {
            route: "PATCH /withdrawals/:id/approve",
            withdrawalId: req.params.id,
            userId: withdrawal.userId,
            error: restoreErr,
          });
        }
      }
      await releaseClaim();

      logWithdrawApprove("speed_api_failed", {
        route: "PATCH /withdrawals/:id/approve",
        withdrawalId: req.params.id,
        status: apiError.response?.status,
        statusText: apiError.response?.statusText,
        responseData: apiError.response?.data,
        message: apiError.message,
      });
      console.error("Speed API error details (approve):", {
        status: apiError.response?.status,
        statusText: apiError.response?.statusText,
        data: apiError.response?.data,
        message: apiError.message,
        payload: config.data,
        // headers deliberately not logged: they carry the Speed API key
        url: config.url,
      });
      if (apiError.response?.data) {
        console.error(
          "Full Speed API error response (approve):",
          JSON.stringify(apiError.response.data, null, 2)
        );
      }

      const speedMessage =
        apiError.response?.data?.errors?.[0]?.message ||
        apiError.response?.data?.error ||
        apiError.message;
      const isInsufficientFunds =
        typeof speedMessage === "string" &&
        speedMessage.toLowerCase().includes("insufficient funds");

      return res
        .status(isInsufficientFunds ? 402 : 500)
        .json({
          error: isInsufficientFunds
            ? "Speed wallet has insufficient funds to send this payment (including network fee). Top up your Speed account at tryspeed.com."
            : "Failed to send withdrawal via Speed API",
          details: speedMessage,
          code: isInsufficientFunds ? "SPEED_INSUFFICIENT_FUNDS" : undefined,
          fullError: apiError.response?.data || null,
        });
    }

    // Validate API response
    if (!responsespeed.data?.id) {
      // Speed answered "OK" but without a payment id: it may have paid. This
      // used to refund the balance, which pays the user twice if it had. Keep
      // the claim and the deduction until an admin has checked Speed.
      await lockAsUnknown("Speed answered without a payment id");
      logWithdrawApprove("speed_api_invalid_response", {
        route: "PATCH /withdrawals/:id/approve",
        withdrawalId: req.params.id,
        responseData: responsespeed.data,
      });
      console.error("Invalid Speed API response:", responsespeed.data);
      return res.status(502).json({
        error: "Speed answered without a payment id, so it is not known whether this payment was sent. The withdrawal is locked and the balance stays deducted. Check it at app.tryspeed.com, then mark it sent or reject it.",
        details: responsespeed.data,
      });
    }

    // 5. Update withdrawal record after successful payment
    withdrawal.status = "SENT";
    withdrawal.txHash = responsespeed.data.id;
    withdrawal.approvedBy = approver;
    withdrawal.approvedAt = new Date();
    withdrawal.action = responsespeed.data;
    await withdrawal.save();
    logWithdrawApprove("withdrawal_sent_saved", {
      route: "PATCH /withdrawals/:id/approve",
      withdrawalId: req.params.id,
      userId: withdrawal.userId,
      txHash: withdrawal.txHash,
      approvedBy: withdrawal.approvedBy,
    });

    // 6. Respond
    logWithdrawApprove("request_completed_success", {
      route: "PATCH /withdrawals/:id/approve",
      withdrawalId: req.params.id,
      userId: withdrawal.userId,
      txHash: withdrawal.txHash,
      speedId: responsespeed.data?.id,
    });
    return res.json({
      message: "Withdrawal approved and sent",
      withdrawal,
      speed: responsespeed.data,
    });
  } catch (err) {
    console.error("Approve withdrawal error:", err);
    logWithdrawApprove("request_failed", {
      route: "PATCH /withdrawals/:id/approve",
      withdrawalId: req.params.id,
      approvedBy: req.user?.id || "system",
      error: err,
    });
    // Unexpected failure. Before the Speed call nothing could have moved, so
    // the admin may retry; after it, the payment may have gone out (e.g. the
    // record failed to save as SENT), so keep the withdrawal locked.
    if (paymentAttempted) await lockAsUnknown(`unexpected error after calling Speed (${err.message})`);
    else await releaseClaim();
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH reject withdrawal (admin)
 */
router.patch("/:id/reject", requireAdminAuth, async (req, res) => {
  try {
    logWithdrawReject("request_received", {
      route: "PATCH /withdrawals/:id/reject",
      withdrawalId: req.params.id,
      rejectedBy: req.user?.id || "system",
      ip: req.ip,
      method: req.method,
    });
    // Take the withdrawal out of PENDING atomically, before refunding, so a
    // second simultaneous reject cannot refund it again and an approval cannot
    // pay it at the same time. Reading it and checking status separately let
    // two rejects both refund.
    //
    // Only a still-pending withdrawal can be rejected: once it's SENT, funds
    // have left via Speed and rejecting would refund a paid withdrawal. While
    // an approval is running (fresh claim) rejecting is refused too. A claim
    // left with an "outcome unknown" note, or older than 5 minutes (the Speed
    // call times out after 60 s), can be rejected once the admin has checked
    // Speed.
    const staleBefore = new Date(Date.now() - 5 * 60 * 1000);
    const withdrawal = await Withdrawal.findOneAndUpdate(
      {
        _id: req.params.id,
        status: "PENDING",
        $or: [
          { approvalStartedAt: null },
          { approvalNote: { $ne: null } },
          { approvalStartedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { status: "FAILED", note: "Rejected by admin", rejectedAt: new Date() } },
      { new: false } // the record as it was, to know whether balance was reserved
    );
    if (!withdrawal) {
      const current = await Withdrawal.findById(req.params.id).lean();
      if (!current) {
        logWithdrawReject("withdrawal_not_found", {
          route: "PATCH /withdrawals/:id/reject",
          withdrawalId: req.params.id,
        });
        return res.status(404).json({ error: "Withdrawal not found" });
      }
      if (current.status !== "PENDING") {
        logWithdrawReject("invalid_status", {
          route: "PATCH /withdrawals/:id/reject",
          withdrawalId: req.params.id,
          status: current.status,
        });
        return res.status(400).json({
          error: `Cannot reject withdrawal with status: ${current.status}`,
        });
      }
      logWithdrawReject("approval_in_progress", {
        route: "PATCH /withdrawals/:id/reject",
        withdrawalId: req.params.id,
        approvalStartedAt: current.approvalStartedAt,
      });
      return res.status(409).json({
        error: "This withdrawal is being approved right now. Wait for that to finish and reload the page.",
        approvalStartedAt: current.approvalStartedAt,
      });
    }

    // create-speed-payment reserves (deducts) balance at creation time, and
    // approval deducts before paying, so a rejected withdrawal that has
    // balanceDeducted must be refunded -- otherwise a genuine user
    // permanently loses that BTC the moment an admin declines their request.
    if (withdrawal.balanceDeducted) {
      const refundAmount = withdrawal.defaultAmountNumeric;
      if (refundAmount !== undefined && refundAmount !== null && Number(refundAmount) > 0) {
        try {
          await restoreBTCDepositBalance(withdrawal.userId, refundAmount);
        } catch (restoreErr) {
          logWithdrawReject("balance_restore_failed", {
            route: "PATCH /withdrawals/:id/reject",
            withdrawalId: req.params.id,
            userId: withdrawal.userId,
            error: restoreErr,
          });
          console.error("Failed to restore balance on reject:", restoreErr);
          // Put it back as it was, so the rejection can be retried.
          await Withdrawal.updateOne(
            { _id: withdrawal._id, status: "FAILED" },
            { $set: { status: "PENDING" }, $unset: { note: 1, rejectedAt: 1 } }
          ).catch(e => console.error("[reject] CRITICAL: could not put withdrawal back to PENDING:", e.message));
          return res.status(500).json({
            error: "Failed to restore user balance during rejection — withdrawal left untouched",
            details: restoreErr.message,
          });
        }
        await Withdrawal.updateOne({ _id: withdrawal._id }, { $set: { balanceDeducted: false } });
        withdrawal.balanceDeducted = false;
      }
    }

    withdrawal.status = "FAILED";
    withdrawal.note = "Rejected by admin";
    logWithdrawReject("request_completed_success", {
      route: "PATCH /withdrawals/:id/reject",
      withdrawalId: req.params.id,
      userId: withdrawal.userId,
      status: withdrawal.status,
      rejectedBy: req.user?.id || "system",
    });

    // TODO: Optionally notify user

    res.json({ message: "Withdrawal rejected", withdrawal });
  } catch (err) {
    console.error("Reject withdrawal error:", err);
    logWithdrawReject("request_failed", {
      route: "PATCH /withdrawals/:id/reject",
      withdrawalId: req.params.id,
      rejectedBy: req.user?.id || "system",
      error: err,
    });
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH mark as sent (after blockchain/bank tx is done)
 */
router.patch("/:id/sent", requireAdminAuth, async (req, res) => {
  try {
    const { txHash } = req.body;
    const withdrawal = await Withdrawal.findByIdAndUpdate(
      req.params.id,
      { status: "SENT", txHash },
      { new: true }
    );
    if (!withdrawal)
      return res.status(404).json({ error: "Withdrawal not found" });

    res.json({ message: "Marked as sent", withdrawal });
  } catch (err) {
    console.error("Mark sent error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH mark as confirmed (after confirmations)
 */
router.patch("/:id/confirm", requireAdminAuth, async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findByIdAndUpdate(
      req.params.id,
      { status: "CONFIRMED" },
      { new: true }
    );
    if (!withdrawal)
      return res.status(404).json({ error: "Withdrawal not found" });

    res.json({ message: "Marked as confirmed", withdrawal });
  } catch (err) {
    console.error("Mark confirmed error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /create-speed-payment
 * Deducts BTC_DEPOSIT, creates withdrawal, and calls Speed APIs
 */
router.post("/create-speed-payment", requireWithdrawalAccess, async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const {
      amount,
      currency = "USD",
      target_currency = "USDT",
      payment_methods = ["lightning"],
      metadata,
      speed_wallet_address,
      baseAmount,
      defaultAmountNumeric,
    } = req.body;


    if (!amount) {
      return res.status(400).json({ error: "Amount is required" });
    }

    const btcAmount = defaultAmountNumeric || baseAmount;
    const limits = await getEffectiveWithdrawalLimits();
    const { minBtc, maxBtc } = limits;
    const btcAmountNum = Number(btcAmount);

    if (!Number.isFinite(btcAmountNum) || btcAmountNum <= 0) {
      return res
        .status(400)
        .json({ error: "Base BTC amount is required and must be a valid positive number" });
    }
    if (btcAmountNum < minBtc) {
      return res.status(400).json({
        error: belowMinimumMessage(limits),
        minBtc,
        maxBtc,
      });
    }
    if (btcAmountNum > maxBtc) {
      return res.status(400).json({
        error: `Withdrawal amount must not exceed ${maxBtc} BTC.`,
        minBtc,
        maxBtc,
      });
    }
    if (!btcAmount || btcAmount <= 0) {
      return res
        .status(400)
        .json({ error: "Base BTC amount is required and must be positive" });
    }

    if (!metadata?.user_id) {
      return res.status(400).json({ error: "User ID is required in metadata" });
    }

    const usersCollection = mongoose.connection.collection("users");
    const metadataUserIdString = String(metadata.user_id || "");
    const metadataUserObjectId =
      mongoose.Types.ObjectId.isValid(metadataUserIdString) && metadataUserIdString.length === 24
        ? new mongoose.Types.ObjectId(metadataUserIdString)
        : null;
    const metadataUserDoc = await usersCollection.findOne(
      metadataUserObjectId
        ? { $or: [{ _id: metadataUserIdString }, { _id: metadataUserObjectId }] }
        : { _id: metadataUserIdString }
    );
    if (!metadataUserDoc) {
      return res.status(400).json({ error: "User not found" });
    }

    if (!speed_wallet_address || !isValidSpeedLN(speed_wallet_address)) {
      return res.status(400).json({ error: "Invalid Speed wallet address" });
    }

    // Check if user already has a pending withdrawal request
    const existingPending = await Withdrawal.findOne({ userId: metadata.user_id, status: "PENDING" });
    if (existingPending) {
      return res.status(409).json({
        error: "You already have a pending withdrawal request. Please wait for it to be processed before creating a new one.",
        pendingWithdrawalId: existingPending._id,
      });
    }

    const balance = await Balance.findOne({ user: metadata.user_id });
    if (!balance) {
      return res.status(400).json({ error: "Balance not found for user" });
    }
    const minedBtc = parseFloat(balance.BTC?.toString() || "0");
    const depositBtc = parseFloat(balance.BTC_DEPOSIT?.toString() || "0");
    if (!Number.isFinite(minedBtc) || minedBtc <= 0) {
      return res.status(400).json({ error: "No mined BTC available for withdrawal." });
    }
    if (depositBtc + minedBtc + 1e-14 < btcAmountNum) {
      return res.status(400).json({ error: "Insufficient balance: requested BTC is greater than your total balance" });
    }

    // Safety net for a stale app-side conversion; see POST / above.
    const amountNum =
      typeof amount === "object" && amount?.toString
        ? Number(amount.toString())
        : Number(amount);
    if (!Number.isFinite(amountNum) || (String(target_currency).toUpperCase() === "USDT" && amountNum < SPEED_MIN_USDT)) {
      return res.status(400).json({
        error: `${belowMinimumMessage(limits)} The payout provider's minimum is ${SPEED_MIN_USDT} USDT.`,
        minBtc,
        maxBtc,
        minAmountUsdt: SPEED_MIN_USDT,
      });
    }

    const btcUsd = await getBtcUsdPriceCached(60_000);

    if (btcUsd > 0) {
      const depositUsdApprox = depositBtc * btcUsd;
      if (depositUsdApprox + 1e-6 < amountNum) {
        return res.status(400).json({
          error:
            "Insufficient balance: USDT/USD notional (amountNumeric) exceeds the value of your on-chain deposit at current rate",
          availableUsdtNotionalApprox: Math.floor(depositUsdApprox * 1e8) / 1e8,
          requestedUsdt: amountNum,
        });
      }
      const impliedUsd = btcAmountNum * btcUsd;
      if (impliedUsd > 0) {
        const relDiff = Math.abs(amountNum - impliedUsd) / Math.max(impliedUsd, 1e-9);
        if (relDiff > 0.15) {
          return res.status(400).json({
            error:
              "amountNumeric and amountBtc are inconsistent: they must match the same withdrawal (within 15% of current BTC/USD)",
            impliedUsdtFromAmountBtc: impliedUsd,
            amountNumeric: amountNum,
          });
        }
      }
    }

    // Start transaction
    await session.startTransaction();
    let updatedBalance, createdWithdrawal;
    try {
      // 1. Check and deduct balance first
      updatedBalance = await deductBTCDepositBalance(
        metadata.user_id,
        btcAmount,
        session
      );

      console.log(
        `Balance deducted for user ${metadata.user_id}: ${btcAmount} from BTC_DEPOSIT`
      );

      // 2. Create withdrawal record
      const withdrawalArr = await Withdrawal.create(
        [
          {
            userId: metadata.user_id,
            asset: target_currency,
            chain: "BTC",
            toAddress: speed_wallet_address,
            amountNumeric: amount,
            defaultAmountNumeric: mongoose.Types.Decimal128.fromString(Number(btcAmount).toFixed(16)),
            status: "PENDING",
            balanceDeducted: true,
            mobileHeadersValid: Boolean(req.mobileAccessMeta?.mobileHeadersValid),
            mobileAccessMeta: req.mobileAccessMeta || null,
          },
        ],
        { session }
      );
      createdWithdrawal = withdrawalArr[0];

      // The withdrawal stops here, PENDING, and money moves only when an admin
      // approves it in PATCH /withdrawals/:id/approve.
      //
      // This route used to call Speed /send itself, which paid every request the
      // moment a user submitted it -- the approval queue existed but nothing ever
      // reached it, because this is the endpoint the app actually calls. Payment
      // must stay in the admin route, which is the only one behind requireAdminAuth
      // and the only one that refunds the balance when a send fails.
      //
      // The balance is deducted here on purpose: it reserves the funds so the same
      // balance cannot be requested twice while the request sits in the queue.
      // approve() honours balanceDeducted rather than deducting again, and reject()
      // refunds it.

      await session.commitTransaction();
      return res.json({
        status: createdWithdrawal.status,
        withdrawal_id: createdWithdrawal._id,
        balance_deducted: btcAmount,
        remaining_btc_deposit: updatedBalance.BTC_DEPOSIT,
        withdrawal: createdWithdrawal,
      });
    } catch (paymentError) {
      await session.abortTransaction();
      // A simultaneous request for the same user won: the transaction (and its
      // balance deduction) is rolled back and this one is reported as a duplicate.
      if (isConcurrentWithdrawalError(paymentError)) {
        return pendingConflict(res, metadata.user_id, "POST /withdrawals/create-speed-payment");
      }
      console.error("Payment processing failed:", paymentError);
      if (paymentError.message.includes("Insufficient BTC_DEPOSIT balance")) {
        return res.status(400).json({
          error: "Insufficient BTC deposit balance",
          details: paymentError.message,
        });
      }
      return res.status(500).json({
        error: "Payment processing failed",
        details: paymentError.message,
      });
    }
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error("Error creating Speed payment:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  } finally {
    await session.endSession();
  }
});

export default router;