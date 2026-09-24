// checkBtcRpc.js
import fetch from "node-fetch";

// Load from env or hardcode for testing
const RPC_URL = process.env.BTC_RPC_URL || "http://127.0.0.1:8332";
const RPC_USER = process.env.BTC_RPC_USER || "btcuser";
const RPC_PASS = process.env.BTC_RPC_PASS || "btmining_112";

async function rpc(method, params = []) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params,
  });

  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " +
          Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64"),
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    if (json.error) {
      throw new Error(JSON.stringify(json.error));
    }
    return json.result;
  } catch (err) {
    console.error("RPC call failed:", err.message);
    throw err;
  }
}

(async () => {
  try {
    console.log("Testing Bitcoin RPC connection...");
    const info = await rpc("getblockchaininfo");
    console.log("✅ RPC connection OK");
    console.log("Network:", info.chain);
    console.log("Blocks:", info.blocks);
  } catch (err) {
    console.error("❌ RPC connection failed:", err.message);
    process.exit(1);
  }
})();
