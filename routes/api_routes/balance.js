// api_routes/balance.js
import express from "express";
import Balance from "../../models/Balance.js";
import BalanceHistory from "../../models/BalanceHistory.js";

const router = express.Router();

// GET balance for a user
router.get("/balance", async (req, res) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    let balance = await Balance.findOne({ user: userId });
    if (!balance) {
      balance = await Balance.create({ user: userId });
    }

    res.json({ balance });
  } catch (err) {
    console.error("Error fetching balance:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST update balance
//
// SECURITY HARDENING:
// - Only the current-session BTC value (Balance.BTC) can be set through this
//   public route. It is used by the mining home screen to sync the live mined
//   amount to the server every ~30s so the cron settlement can take
//   min(syncedBtc, serverComputed) when rolling the day over.
// - All other balance fields (BTC_DEPOSIT, BNB, USDT, USDC, LTC) are the
//   ledger and must NEVER be mutated through a public API. They are written
//   only by trusted internal paths (cron daily settlement, btcWatcher webhook
//   for real BTC deposits, withdrawal flow, referral reward service).
// - amount is validated as a finite, non-negative number.
router.post("/balance", async (req, res) => {
  try {
    const { userId, asset, amount } = req.body;
    if (!userId || !asset || amount === undefined) {
      return res
        .status(400)
        .json({ error: "Missing required fields (userId, asset, amount)" });
    }

    if (asset !== "BTC") {
      return res.status(403).json({
        error:
          "Direct balance mutation is not permitted for this asset. ",
      });
    }

    const numericAmount = Number(amount);
    // A negative value was accepted and written straight into the balance,
    // which corrupts the withdrawal checks that add BTC and BTC_DEPOSIT.
    if (!Number.isFinite(numericAmount) || numericAmount < 0 || numericAmount > 0.0000009) {
      console.error("Invalid amount", amount);
      return res.status(400).json({ error: "Invalid amount" });
    }

    let balance = await Balance.findOne({ user: userId });
    if (!balance) {
      balance = await Balance.create({ user: userId });
    }

    balance.BTC = numericAmount;
    await balance.save();

    console.log(
      `Synced BTC session balance for User: ${userId}, Balance: ${numericAmount}`
    );

    res.json({ success: true, balance });
  } catch (err) {
    console.error("Error updating balance:", err);
    res.status(500).json({ error: "Server error" });
  }
});

router.get("/history", async (req, res) => {
  try {
    const { userId } = req.query;



    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const history = await BalanceHistory.find({ user: userId })
    .sort({ date: -1 })
    .limit(10)
    .lean();

    

    // res.json({ success: true, balances: history });
    const totalResult = await BalanceHistory.aggregate([
      { $match: { user: userId } },
      { $group: { _id: null, total: { $sum: "$balances.BTC" } } },
    ]);

    console.log("totalResult: ", totalResult);
    const rawTotal = totalResult[0]?.total;
    const totalHistoricalBTC =
      rawTotal != null
        ? typeof rawTotal === "object" && typeof rawTotal.toString === "function"
          ? parseFloat(rawTotal.toString())
          : Number(rawTotal)
        : 0;

    res.json({
      success: true,
      balances: history,
      totalHistoricalBTC,
    });
  } catch (err) {
    console.error("Error fetching balance history:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
