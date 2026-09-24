// /helpers/sync_wallets.js
import mongoose from "mongoose";
import fetch from "node-fetch";
import WalletAddress from "../models/WalletAddress.js";

// ---- ENV ----
const MONGO_URI = process.env.MONGODB_URI;
const RPC_USER = process.env.BTC_RPC_USER || "btcuser";
const RPC_PASS = process.env.BTC_RPC_PASS || "btmining_112";
const RPC_HOST = process.env.BTC_RPC_HOST || "127.0.0.1";
const RPC_PORT = process.env.BTC_RPC_PORT || 8332;

// ---- RPC helper ----
async function rpcCall(method, params = [], wallet = null) {
  const url = wallet
    ? `http://${RPC_HOST}:${RPC_PORT}/wallet/${wallet}`
    : `http://${RPC_HOST}:${RPC_PORT}`;

  const auth = Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      jsonrpc: "1.0",
      id: Date.now(),
      method,
      params,
    }),
  });

  if (!res.ok) {
    throw new Error(`RPC HTTP Error ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

// ---- Main logic ----
async function syncWallets() {
  await mongoose.connect(MONGO_URI);
  console.log("Connected to MongoDB.");

  const addresses = await WalletAddress.find({ chain: "btc" }).lean();
  console.log(`Found ${addresses.length} BTC addresses in DB.`);

  for (const addr of addresses) {
    const walletName = `wallet_${addr.userId}`;

    try {
      // Ensure wallet exists
      try {
        await rpcCall("createwallet", [walletName, true]);
        console.log(`Wallet ${walletName} created.`);
      } catch (e) {
        if (e.message.includes("Database already exists") || e.message.includes("already loaded")) {
          await rpcCall("loadwallet", [walletName]);
          console.log(`Wallet ${walletName} loaded.`);
        } else {
          throw e;
        }
      }

      // Check existing addresses in wallet
      const existing = await rpcCall("getaddressesbylabel", [""], walletName).catch(() => ({}));
      if (Object.keys(existing).includes(addr.address)) {
        console.log(`Address ${addr.address} already in wallet ${walletName}`);
        continue;
      }

      // Import as watch-only (no rescan for speed)
      await rpcCall("importaddress", [addr.address, "", false], walletName);
      console.log(`Imported address ${addr.address} into ${walletName}`);

    } catch (err) {
      console.error(`Error processing ${addr.address} (user ${addr.userId}):`, err.message);
    }
  }

  await mongoose.disconnect();
  console.log("Done.");
}

syncWallets().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
