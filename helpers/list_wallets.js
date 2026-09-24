// list_wallets.js
import fetch from "node-fetch";

const RPC_USER = process.env.BTC_RPC_USER || "btcuser";
const RPC_PASS = process.env.BTC_RPC_PASS || "btmining_112";
const RPC_PORT = process.env.BTC_RPC_PORT || 8332;
const RPC_HOST = process.env.BTC_RPC_HOST || "127.0.0.1";

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

async function main() {
  try {
    // 1. List wallets
    const wallets = await rpcCall("listwallets");
    if (!wallets.length) {
      console.log("No wallets loaded.");
      return;
    }

    for (const wallet of wallets) {
      console.log(`\n=== Wallet: ${wallet} ===`);

      // 2. Get balance
      const balance = await rpcCall("getbalance", [], wallet);
      console.log(`Balance: ${balance} BTC`);

      // 3. List received addresses
      const addrs = await rpcCall("listreceivedbyaddress", [0, true], wallet);
      if (addrs.length === 0) {
        console.log("No addresses in this wallet.");
      } else {
        for (const entry of addrs) {
          console.log(
            `Address: ${entry.address}, Amount: ${entry.amount} BTC, Confirmations: ${entry.confirmations}`
          );
        }
      }
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}

main();
