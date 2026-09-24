// sweepByAddress.js
import fetch from "node-fetch";
import { execSync } from "child_process";

const BTC_RPC_USER = process.env.BTC_RPC_USER || "btcuser";
const BTC_RPC_PASS = process.env.BTC_RPC_PASS || "btmining_112";
const BTC_RPC_URL = process.env.BTC_RPC_URL || "http://127.0.0.1:8332";
const HOT_WALLET_ADDRESS = process.env.BTC_HOT_WALLET || "bc1qedzf2qx3m6f4thfhgwn3h5dt2226f3t3tyzgaf";

const DEPOSIT_ADDRESS = "bc1qqy9cuqvkrmwfqcwq9trl9jwklwlnraj3z8w80r"; // deposit address
if (!DEPOSIT_ADDRESS) {
  console.error("Usage: node sweepByAddress.js <deposit-address>");
  process.exit(1);
}

function rpc(wallet, method, params = []) {
  let url = BTC_RPC_URL;
  if (wallet) url += `/wallet/${wallet}`;

  return fetch(url, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Basic " + Buffer.from(`${BTC_RPC_USER}:${BTC_RPC_PASS}`).toString("base64"),
    },
  })
    .then((res) => res.json())
    .then((json) => {
      if (json.error) throw new Error(JSON.stringify(json.error));
      return json.result;
    });
}

async function findWalletWithAddress(address) {
    console.log(address);
  const wallets = execSync("bitcoin-cli listwallets").toString();
  const walletList = JSON.parse(wallets);

  for (const wallet of walletList) {
    try {
      const utxos = await rpc(wallet, "listunspent", [0, 9999999, [address]]);
      if (utxos.length > 0) {
        return { wallet, utxos };
      }
    } catch (err) {
      console.error(`Error checking wallet ${wallet}:`, err.message);
    }
  }
  return null;
}

async function sweepFunds() {
  const found = await findWalletWithAddress(DEPOSIT_ADDRESS);

  if (!found) {
    console.error("No wallet contains the deposit address or UTXO not available.");
    return;
  }

  const { wallet, utxos } = found;
  console.log(`Found ${utxos.length} UTXO(s) in wallet: ${wallet}`);

  const totalSats = utxos.reduce((sum, u) => sum + u.amount * 1e8, 0);
  console.log(`Total amount to sweep: ${totalSats} sats`);

  try {
    const txid = await rpc(wallet, "sendtoaddress", [HOT_WALLET_ADDRESS, totalSats / 1e8]);
    console.log(`Swept all funds to hot wallet. TXID: ${txid}`);
  } catch (err) {
    console.error("Error sweeping funds:", err.message);
  }
}

sweepFunds();
