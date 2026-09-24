// ws/alchemyWatcher.js — BSC Alchemy WebSocket (optional if ALCHEMY_WSS_URL is unset)
import WebSocket from "ws";
import WalletAddress from "../models/WalletAddress.js";

const ALCHEMY_WS_URL = process.env.ALCHEMY_WSS_URL || process.env.ALCHEMY_WS_URL;

let socket;
const subscribedAddresses = new Set();
/** Backoff after 429 or errors (cap 15 min) */
let reconnectDelayMs = 5000;
const MIN_RECONNECT = 5000;
const MAX_RECONNECT = 900000;
let reconnectTimer = null;

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = reconnectDelayMs;
  console.log(`WS reconnect scheduled in ${Math.round(delay / 1000)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectAlchemyWS().catch(console.error);
  }, delay);
}

async function connectAlchemyWS() {
  if (!ALCHEMY_WS_URL || !ALCHEMY_WS_URL.startsWith("wss://")) {
    console.warn(
      "[Alchemy WS] SKIPPED: set ALCHEMY_WSS_URL in .env (e.g. wss://bnb-mainnet.g.alchemy.com/v2/YOUR_KEY)"
    );
    return null;
  }

  return new Promise((resolve, reject) => {
    socket = new WebSocket(ALCHEMY_WS_URL);

    socket.on("open", async () => {
      reconnectDelayMs = MIN_RECONNECT;
      console.log("Connected to Alchemy WS");
      const wallets = await WalletAddress.find({ chain: "bsc" });
      wallets.forEach((w) => subscribeAddress(w.address));
      resolve(socket);
    });

    socket.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id && msg.result) {
          console.log("Subscription successful. ID:", msg.result);
          return;
        }
        if (msg.params?.result) {
          const tx = msg.params.result;
          const to = tx.to?.toLowerCase();
          if (to && subscribedAddresses.has(to)) {
            console.log(`Deposit detected:`, {
              asset: tx.asset,
              amount: Number(tx.value) / 10 ** tx.decimals,
              from: tx.from,
              to,
            });
          }
        }
      } catch (err) {
        console.error("WS message error:", err);
      }
    });

    socket.on("close", () => {
      console.log("WS closed, reconnecting...");
      scheduleReconnect();
    });

    socket.on("error", (err) => {
      const msg = err.message || String(err);
      console.error("WS error:", msg);
      if (msg.includes("429")) {
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT);
        console.warn(
          "[Alchemy WS] Rate limited (429). Increasing backoff. Check Alchemy plan/limits and reduce reconnect churn."
        );
      }
      try {
        socket.close();
      } catch (_) {}
    });
  });
}

export default connectAlchemyWS;

export function subscribeAddress(address) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    console.warn("WS not ready yet for:", address);
    return;
  }

  const sub = {
    jsonrpc: "2.0",
    method: "alchemy_subscribe",
    params: [
      "alchemy_filteredAssetTransfers",
      {
        toAddress: address,
        category: ["external", "erc20"],
      },
    ],
    id: Date.now(),
  };

  subscribedAddresses.add(address.toLowerCase());
  socket.send(JSON.stringify(sub));
}
