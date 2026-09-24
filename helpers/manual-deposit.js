// manualCreditAndSweep.js
import mongoose from "mongoose";
import Deposit from "../models/Deposit.js";
import Balance from "../models/Balance.js";

// ---- CONFIG ----
const MONGO_URI = process.env.MONGO_URI;
const BTC_HOT_WALLET = process.env.BTC_HOT_WALLET || "bc1qedzf2qx3m6f4thfhgwn3h5dt2226f3t3tyzgaf";

// ---- PARAMETERS ----
const TX_HASH = "f971fce829d474ba4ab57dc74de57969bee24a83b78952fdd47af4cd7e3a4bf4";
const USER_ID = "68cbc9c544790a54101e1b6c";
const AMOUNT_SATS = 14816;
const VOUT_INDEX = 8;

async function rpc(method, params = []) {
  const url = new URL(process.env.BTC_RPC_URL || "http://127.0.0.1:8332/wallet/descriptor-wallet-1758185373792");
  const authUser = process.env.BTC_RPC_USER || "btcuser";
  const authPass = process.env.BTC_RPC_PASS || "btmining_112";

  const res = await fetch(url.toString(), {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Basic " + Buffer.from(`${authUser}:${authPass}`).toString("base64"),
    },
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
  return json.result;
}

// Sweeper function
async function sweepDeposit(dep) {
  if (!BTC_HOT_WALLET) {
    console.warn("Sweeper: BTC_HOT_WALLET not configured, skipping sweep");
    return;
  }

  try {
    // sendtoaddress in BTC
    const txid = await rpc("sendtoaddress", [BTC_HOT_WALLET, dep.amountNumeric / 1e8]);
    dep.swept = true;
    dep.sweptTx = txid;
    dep.sweptAt = new Date();
    await dep.save();
    console.log(`Sweeper: swept ${dep.amountNumeric} sats to hot wallet (txid=${txid})`);
  } catch (e) {
    console.error("Sweeper error:", e.message);
  }
}

async function main() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB");

    // // Update Deposit
    // const depResult = await Deposit.updateOne(
    //   { txHash: TX_HASH },
    //   {
    //     $set: {
    //       credited: true,
    //       confirmations: 1,
    //       vout: VOUT_INDEX,
    //     },
    //   },
    //   { upsert: true }
    // );
    // console.log("Deposit updated:", depResult);

    // // Update Balance
    // const balResult = await Balance.updateOne(
    //   { user: USER_ID },
    //   { $inc: { BTC: AMOUNT_SATS } },
    //   { upsert: true }
    // );
    // console.log("Balance updated:", balResult);

    // Fetch the deposit document to sweep
    const depDoc = await Deposit.findOne({ txHash: TX_HASH });
    if (depDoc) {
      console.log("Starting sweep for this deposit...");
      await sweepDeposit(depDoc);
    } else {
      console.warn("Deposit document not found for sweeping!");
    }

    console.log(`✅ Deposit credited and swept for user ${USER_ID}`);
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await mongoose.disconnect();
  }
}

main();
