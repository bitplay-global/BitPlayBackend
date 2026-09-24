/**
 * create_descriptor_wallet.js
 *
 * Creates a descriptor wallet in Bitcoin Core, generates a receive address,
 * and saves descriptors (both private + public) with XPUB for recovery.
 *
 * Requirements:
 *  - Bitcoin Core with RPC enabled
 *  - Node 18+ (has fetch built-in)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const RPC_USER = 'btcuser';
const RPC_PASS = 'btmining_112';
const RPC_HOST = process.env.BTC_RPC_HOST || '127.0.0.1';
const RPC_PORT = process.env.BTC_RPC_PORT || '8332';

if (!RPC_USER || !RPC_PASS) {
  console.error('ERROR: Set BTC_RPC_USER and BTC_RPC_PASS environment variables.');
  process.exit(1);
}

const rpcBaseUrl = `http://${RPC_HOST}:${RPC_PORT}`;

let idCounter = 0;
async function rpcCall(method, params = [], walletName = null) {
  const url = walletName
    ? `${rpcBaseUrl}/wallet/${encodeURIComponent(walletName)}`
    : rpcBaseUrl;

  const body = { jsonrpc: '1.0', id: `${++idCounter}`, method, params };
  const auth = Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

(async () => {
  try {
    const walletName = `descriptor-wallet-${Date.now()}`;
    console.log(`Creating descriptor wallet: ${walletName}`);

    // Create descriptor wallet
    try {
      const createRes = await rpcCall('createwallet', [
        walletName, false, false, '', false, true, true
      ]);
      console.log('createwallet result:', createRes);
    } catch (err) {
      if (String(err).includes('already exists')) {
        console.log(`Wallet ${walletName} exists, loading...`);
        await rpcCall('loadwallet', [walletName]);
      } else {
        throw err;
      }
    }

    // New bech32 address
    console.log('Generating a new bech32 address...');
    const newAddress = await rpcCall('getnewaddress', ['', 'bech32'], walletName);
    console.log('New address:', newAddress);

    // Descriptors with private keys
    const descriptorsPriv = await rpcCall('listdescriptors', [true], walletName);
    // Descriptors with only public keys (for XPUB)
    const descriptorsPub = await rpcCall('listdescriptors', [false], walletName);

    // Extract XPUB
    let xpub = null;
    for (const d of descriptorsPub.descriptors) {
      const match = d.desc.match(/(xpub[0-9A-Za-z]+)/);
      if (match) {
        xpub = match[1];
        break;
      }
    }

    if (!xpub) {
      console.warn('Could not find XPUB in public descriptors!');
    }

    // Save backup
    const baseDir = path.join(os.homedir(), '.bitcoin', 'wallets');
    ensureDir(baseDir);
    const backupPath = path.join(baseDir, `${walletName}-backup.json`);

    const saveObject = {
      walletName,
      createdAt: new Date().toISOString(),
      bitcoindRpc: { host: RPC_HOST, port: RPC_PORT },
      newAddress,
      xpub,
      descriptors: {
        private: descriptorsPriv,
        public: descriptorsPub
      }
    };

    fs.writeFileSync(backupPath, JSON.stringify(saveObject, null, 2), { mode: 0o600 });

    console.log(`\nDescriptors + XPUB saved to: ${backupPath}`);
    console.log('*** IMPORTANT: The private section contains xprv, keep this file safe! ***');
    console.log(`Wallet ready.`);
    console.log(`Receive address: ${newAddress}`);
    console.log(`XPUB: ${xpub || 'NOT FOUND'}`);

  } catch (err) {
    console.error('Error:', err.message || err);
    process.exit(1);
  }
})();
