// /btcWatcher.js
import * as zmq from "zeromq";
import * as bitcoin from "bitcoinjs-lib";
import WalletAddress from "../models/WalletAddress.js";
import Deposit from "../models/Deposit.js";
import Balance from "../models/Balance.js";

// ---- ENV ----
const BTC_NETWORK = (process.env.BTC_NETWORK || "mainnet").toLowerCase();
const BTC_ZMQ_TX = process.env.BTC_ZMQ_TX || "tcp://127.0.0.1:28332";
const BTC_ZMQ_BLOCK = process.env.BTC_ZMQ_BLOCK || "tcp://127.0.0.1:28333";
const BTC_MIN_CONFS = Number(process.env.BTC_MIN_CONFS || "1");

// RPC
const BTC_RPC_URL = process.env.BTC_RPC_URL || "http://btcuser:btmining_112@127.0.0.1:18332/";

// Sweeper target wallet
const BTC_HOT_WALLET = process.env.BTC_HOT_WALLET || "bc1qedzf2qx3m6f4thfhgwn3h5dt2226f3t3tyzgaf";

// ---- NETWORK ----
const network =
  BTC_NETWORK === "mainnet" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;

// ---- in-memory set of watched deposit addresses ----
const watched = new Set();

// preload addresses on boot
async function loadWatchedAddresses() {
  const addrs = await WalletAddress.find({ chain: "btc" }, { address: 1 }).lean();
  for (const a of addrs) watched.add(a.address);
  console.log(`BTC watcher: preloaded ${watched.size} addresses to watch`);
}

export function registerBtcAddress(addr) {
  watched.add(addr);
}

// ---- helpers ----
async function rpc(method, params = []) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params });

  // Parse from env
  const walletName = process.env.BTC_WALLET || "watchonly";
  const url = new URL(`http://127.0.0.1:8332/wallet/${walletName}`);
  const authUser = process.env.BTC_RPC_USER || "btcuser";
  const authPass = process.env.BTC_RPC_PASS || "btmining_112";

  const res = await fetch(url.toString(), {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Basic " + Buffer.from(`${authUser}:${authPass}`).toString("base64"),
    },
  });

  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
  return json.result;
}

// ---- Sweeper ----
async function sweepDeposit(dep) {
  if (!BTC_HOT_WALLET) {
    console.warn("Sweeper: BTC_HOT_WALLET not configured, skipping sweep");
    return;
  }

  try {
    // Sweep using RPC sendtoaddress
    const txid = await rpc("sendtoaddress", [BTC_HOT_WALLET, dep.amountNumeric / 1e8]);

    dep.swept = true;
    dep.sweptTx = txid;
    dep.sweptAt = new Date();
    await dep.save();

    console.log(`Sweeper: swept ${dep.amountNumeric} sats from deposit ${dep.txHash} to hot wallet (txid=${txid})`);
  } catch (e) {
    console.error("Sweeper error:", e.message);
  }
}

async function confirmBtcPayment(userId, btcValue) {
  try {
    // BTC price from Binance
    const res = await axios.get("https://api.binance.com/api/v3/ticker/price", {
      params: { symbol: "BTCUSDT" },
    });

    const btcPrice = parseFloat(res.data.price); // live BTC price in USD

    // Convert BTC to USD
    const usdValue = btcValue * btcPrice;

    console.log(`BTC Value: ${btcValue}, USD Equivalent: ${usdValue}`);

    // unpaid user plans
    const unpaidPlans = await Userplan.find({
      user: userId,
      paid: false,
    });

    if (!unpaidPlans.length) {
      console.log("No unpaid plans found for user.");
      return { success: false, message: "No unpaid plans." };
    }

    // Compare values with tolerance and update
    let updatedCount = 0;

    for (let plan of unpaidPlans) {
      const planAmount = parseFloat(plan.amount.toString()); // Decimal128 → string → float

      // allow tolerance of ±2 USD
      if (Math.abs(planAmount - usdValue) <= 2) {
        plan.paid = true;
        await plan.save();
        updatedCount++;
        console.log(`Plan ${plan._id} marked as paid`);
      } else {
        console.log(
          `Plan ${plan._id} not marked as paid. Expected ~${planAmount}, got ${usdValue}`
        );
      }
    }

    return {
      success: true,
      message: `${updatedCount} plan(s) updated.`,
      updatedCount,
    };
  } catch (err) {
    console.error("Error confirming BTC payment:", err.message);
    return { success: false, message: "Error confirming BTC payment." };
  }
}

// ---- confirmations updater ----
async function updateConfirmationsForPending(txids) {
  try {
    // fetch all UTXOs from watch-only wallet
    const utxos = await rpc("listunspent", [0, 9999999]); // include unconfirmed too

    // index by txid for faster lookup
    const utxoMap = new Map();
    for (const u of utxos) {
      utxoMap.set(`${u.txid}:${u.vout}`, u);
    }

    for (const txid of txids) {
      const dep = await Deposit.findOne({ txHash: txid, chain: "btc" });
      if (!dep) continue;

      const key = `${dep.txHash}:${dep.vout || 0}`;
      const u = utxoMap.get(key);

      if (!u) {
        // not found in UTXO set anymore — could be spent or pruned
        console.warn(`UTXO for ${txid} not found in listunspent`);
        continue;
      }

      const confs = u.confirmations || 0;
      if (confs !== dep.confirmations) {
        dep.confirmations = confs;

        // credit when reaching threshold & not yet credited
        if (!dep.credited && confs >= BTC_MIN_CONFS) {
          dep.credited = true;
          dep.creditedAt = new Date();
          console.log("BitcoinWatcher Depositing Funds", dep.userId, dep.amountNumeric);

          const user_sub_res = await confirmBtcPayment(dep.userId, dep.amountNumeric);

          console.log("User Sub Update Response: ", user_sub_res);

          await Balance.updateOne(
            { user: dep.userId },
            { $inc: { BTC_DEPOSIT: dep.amountNumeric } },
            { upsert: true }
          );

          console.log(
            `BTC credited user ${dep.userId} ${dep.amountNumeric} BTC (tx ${txid})`
          );

          // Trigger sweeper after credit
          await sweepDeposit(dep);
        }

        await dep.save();
      }
    }
  } catch (e) {
    console.error("confirmations update error (listunspent):", e.message);
  }
}

// ---- raw tx parser ----
async function handleRawTx(txHex) {
  const tx = bitcoin.Transaction.fromHex(txHex);
  const txid = tx.getId();

  // scan outputs for watched addresses
  const hits = [];
  for (let n = 0; n < tx.outs.length; n++) {
    const out = tx.outs[n];
    try {
      const addr = bitcoin.address.fromOutputScript(out.script, network);
      if (watched.has(addr)) {
        hits.push({ n, addr, value: out.value }); // out.value is sats
      }
    } catch {
      // non-standard script or can't decode -> ignore
    }
  }

  if (hits.length === 0) return;

  for (const hit of hits) {
    const rec = await WalletAddress.findOne({ chain: "btc", address: hit.addr });
    if (!rec) continue;

    const BTC_VALUE = hit.value / 1e8; // sats to BTC

    // idempotent upsert
    await Deposit.updateOne(
      { txHash: txid, chain: "btc", address: hit.addr },
      {
        $setOnInsert: {
          userId: rec.userId,
          asset: "BTC",
          chain: "btc",
          amountNumeric: BTC_VALUE,
          confirmations: 0,
          credited: false,
          swept: false,
          vout: hit.n,  // <-- store output index
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    console.log(`BTC deposit seen -> user ${rec.userId} addr ${hit.addr} +${hit.value} sats (tx ${txid})`);
  }
}

// ---- block handler ----
async function handleRawBlock(_blockHex) {
  // simple strategy: check the last N uncredited deps each block
  const pending = await Deposit.find({ chain: "btc", credited: false }).limit(200).lean();
  const txids = [...new Set(pending.map((d) => d.txHash))];
  if (txids.length) await updateConfirmationsForPending(txids);
}

// ---- main watcher ----
export async function connectBTCWatcher() {
  await loadWatchedAddresses();

  // ZMQ sockets
  const txSock = new zmq.Subscriber();
  txSock.connect(BTC_ZMQ_TX);
  txSock.subscribe("rawtx");

  const blockSock = new zmq.Subscriber();
  blockSock.connect(BTC_ZMQ_BLOCK);
  blockSock.subscribe("rawblock");

  console.log(`BTC watcher connected to ZMQ: tx=${BTC_ZMQ_TX}, block=${BTC_ZMQ_BLOCK}`);

  (async () => {
    for await (const [topic, body] of txSock) {
      if (topic.toString() !== "rawtx") continue;
      const txHex = body.toString("hex");
      try {
        await handleRawTx(txHex);
      } catch (e) {
        console.error("rawtx handle error:", e.message);
      }
    }
  })();

  (async () => {
    for await (const [topic, body] of blockSock) {
      if (topic.toString() !== "rawblock") continue;
      const blockHex = body.toString("hex");
      try {
        await handleRawBlock(blockHex);
      } catch (e) {
        console.error("rawblock handle error:", e.message);
      }
    }
  })();
}

// ---- utils ----
export function getWatchedAddressesCount() {
  return watched.size;
}

export function getWatchedAddresses() {
  return Array.from(watched);
}
