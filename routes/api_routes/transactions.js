import express from 'express';
import Transaction from '../../models/Transaction.js';
import Deposit from '../../models/Deposit.js';
import Withdrawal from '../../models/Withdrawal.js';
import mongoose from 'mongoose';
import { requireAdminAuth } from "../../middleware/requireAdminAuth.js";

const router = express.Router();

// POST /api/transactions/create
router.post('/create', requireAdminAuth, async (req, res) => {
  try {
    const {
      user, // should be a valid ObjectId
      amount,
      method_crypto,
      method_bank_transfer,
      method_payment_gateway,
      crypto_type,
      crypto_wallet_address,
      transaction_id,
      plan_id,
      deposit,
      withdraw,
      extra_details
    } = req.body;

    // Basic validations
    if (!user || !plan_id || !transaction_id || amount == null) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    // Check for valid ObjectId
    if (!mongoose.Types.ObjectId.isValid(user) || !mongoose.Types.ObjectId.isValid(plan_id)) {
      return res.status(400).json({ error: 'Invalid user or plan ID.' });
    }

    // Check if transaction ID already exists
    const existingTx = await Transaction.findOne({ transaction_id });
    if (existingTx) {
      return res.status(409).json({ error: 'Transaction ID already exists.' });
    }

    const newTx = new Transaction({
      user,
      amount,
      method_crypto: !!method_crypto,
      method_bank_transfer: !!method_bank_transfer,
      method_payment_gateway: !!method_payment_gateway,
      crypto_type: crypto_type || null,
      crypto_wallet_address: crypto_wallet_address || null,
      transaction_id,
      plan_id,
      deposit: !!deposit,
      withdraw: !!withdraw,
      extra_details: extra_details || null
    });

    await newTx.save();

    return res.status(201).json({ message: 'Transaction created successfully', transaction: newTx });
  } catch (error) {
    console.error('Error creating transaction:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get all transactions for a specific user
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const transactions = await Transaction.find({ user: userId }).sort({ date_created: -1 });

    res.status(200).json({
      success: true,
      count: transactions.length,
      transactions
    });
  } catch (err) {
    console.error('Error fetching user transactions:', err);
    res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// helper function
async function getUserTransactions(userId, days = null) {
  // build date filter if days passed
  let depositFilter = { userId };
  let withdrawalFilter = { userId };

  if (days) {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    depositFilter.createdAt = { $gte: fromDate };
    withdrawalFilter.created_at = { $gte: fromDate };
  }

  // 1. Fetch deposits and withdrawals
  const [deposits, withdrawals] = await Promise.all([
    Deposit.find(depositFilter).sort({ createdAt: -1 }).lean(),
    Withdrawal.find(withdrawalFilter).sort({ created_at: -1 }).lean()
  ]);

  // 2. Collect all unique assets
  const assets = new Set([
    ...deposits.map(d => d.asset.toUpperCase()),
    ...withdrawals.map(w => w.asset.toUpperCase())
  ]);

  const assetMap = { BTC: 'bitcoin', USDT: 'tether', USDC: 'usd-coin' };

  const ids = Array.from(assets)
    .map(a => assetMap[a])
    .filter(Boolean)
    .join(',');

  let prices = {};
  if (ids.length > 0) {
    try {
      // CoinGecko first
      const priceRes = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
      );
      if (!priceRes.ok) throw new Error(`CoinGecko error: ${priceRes.status}`);
      prices = await priceRes.json();
    } catch (err) {
      console.warn("CoinGecko failed, falling back to Binance:", err.message);
      // Binance fallback
      try {
        for (const id of ids.split(",")) {
          let symbol;
          switch (id.toLowerCase()) {
            case "bitcoin":
              symbol = "BTCUSDT"; break;
            case "ethereum":
              symbol = "ETHUSDT"; break;
            case "tether":
              prices[id] = { usd: 1 }; continue;
            case "usd-coin":
              prices[id] = { usd: 1 }; continue;
            default:
              console.warn(`No Binance mapping for ${id}`); continue;
          }

          const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
          if (!res.ok) throw new Error(`Binance error: ${res.status}`);
          const data = await res.json();
          prices[id] = { usd: parseFloat(data.price) };
        }
      } catch (binanceErr) {
        console.error("Binance fallback failed:", binanceErr.message);
      }
    }
  }

  // 3. Convert helper
  const convertToUSD = (asset, amount) => {
    const id = assetMap[asset.toUpperCase()];
    if (!id || !prices[id]) return null;
    const usdPrice = prices[id].usd || 0;
    return (parseFloat(amount.toString()) * usdPrice).toFixed(2);
  };

  // 4. Format deposits
  const depositTxs = deposits.map(d => ({
    type: 'DEPOSIT',
    method: d.chain,
    date: d.createdAt.toISOString(),
    amount: parseFloat(d.amountNumeric.toString()).toFixed(2),
    amountNumeric: { $numberDecimal: convertToUSD(d.asset, d.amountNumeric) },
    isPositive: true,
    credited: d.credited
  }));

  // 5. Format withdrawals
  const withdrawalTxs = withdrawals.map(w => ({
    type: 'WITHDRAW',
    method: w.chain,
    date: w.created_at.toISOString(),
    amount: parseFloat(w.amountNumeric.toString()).toFixed(2),
    amountNumeric: { $numberDecimal: convertToUSD(w.asset, w.amountNumeric) },
    isPositive: false,
    status: w.status,
  }));

  // 6. Merge & sort
  const transactions = [...depositTxs, ...withdrawalTxs].sort(
    (a, b) => new Date(b.date) - new Date(a.date)
  );

  console.log("Transactions: ", transactions);

  return {
    count: transactions.length,
    transactions
  };
}

// all transactions
router.get('/all/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const data = await getUserTransactions(userId); // no days => all
    return res.status(200).json({ success: true, ...data });
  } catch (err) {
    console.error("Error fetching user transactions:", err);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
});

// last 7 days transactions
router.get('/last7days/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const data = await getUserTransactions(userId, 7);
    return res.status(200).json({ success: true, ...data });
  } catch (err) {
    console.error("Error fetching user transactions:", err);
    return res.status(500).json({ success: false, message: 'Server Error' });
  }
});


export default router;
