#!/usr/bin/env node
/**
 * check-and-sweep-wif.mjs
 *
 * Usage:
 *  node check-and-sweep-wif.mjs <WIF> [--dest <DEST_ADDR>] [--broadcast]
 *
 * Environment (optional):
 *  BTC_RPC_HOST, BTC_RPC_PORT, BTC_RPC_USER, BTC_RPC_PASS
 *
 * What it does:
 *  - validate WIF
 *  - derive addresses (p2pkh, p2sh-p2wpkh, p2wpkh)
 *  - query UTXOs (Bitcoin Core scantxoutset if RPC set, else Blockstream API)
 *  - if dest provided and UTXOs found: build PSBT to sweep all funds to dest
 *    sign PSBT with the private key and output final tx hex
 *  - if --broadcast and RPC configured: broadcast via bitcoin-cli RPC sendrawtransaction
 *
 * IMPORTANT: This script will print private-key derived info to stdout. Treat with care.
 */

import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import ECPairFactory from "ecpair";

const ECPair = ECPairFactory(ecc);

const network = bitcoin.networks.bitcoin;

const fetchFn = globalThis.fetch;

function usageAndExit(msg) {
  if (msg) console.error(msg);
  console.error("\nUsage: node check-and-sweep-wif.mjs <WIF> [--dest <DEST_ADDR>] [--broadcast]\n");
  process.exit(msg ? 1 : 0);
}

const args = process.argv.slice(2);
if (args.length === 0) usageAndExit("Missing WIF argument");

let WIF = args[0];
let dest = null;
let doBroadcast = false;
for (let i = 1; i < args.length; i++) {
  if (args[i] === "--dest" && args[i+1]) {
    dest = args[i+1];
    i++;
  } else if (args[i] === "--broadcast") {
    doBroadcast = true;
  } else {
    usageAndExit(`Unknown arg: ${args[i]}`);
  }
}

// RPC configuration (optional)
const RPC_HOST = process.env.BTC_RPC_HOST || "127.0.0.1";
const RPC_PORT = process.env.BTC_RPC_PORT || "8332";
const RPC_USER = process.env.BTC_RPC_USER || "btcuser";
const RPC_PASS = process.env.BTC_RPC_PASS || "btmining_112";
const rpcBase = RPC_HOST && RPC_USER && RPC_PASS ? `http://${RPC_HOST}:${RPC_PORT}` : null;

async function rpcCall(method, params = []) {
  if (!rpcBase) throw new Error("RPC not configured");
  const body = { jsonrpc: "1.0", id: "1", method, params };
  const auth = Buffer.from(`${RPC_USER}:${RPC_PASS}`).toString("base64");
  const res = await fetchFn(rpcBase, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC HTTP ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

function deriveAddressesFromKeyPair(keyPair) {
  const pubkey = keyPair.publicKey; // Buffer
  // P2PKH (legacy)
  const p2pkh = bitcoin.payments.p2pkh({ pubkey: Buffer.from(pubkey), network });
  // P2WPKH (native segwit bech32)
  const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pubkey), network });
  // P2SH-P2WPKH (wrapped segwit)
  const p2shwpkh = bitcoin.payments.p2sh({
    redeem: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(pubkey), network }),
    network,
  });

  return {
    p2pkh: p2pkh.address,
    p2wpkh: p2wpkh.address,
    p2shwpkh: p2shwpkh.address,
  };
}

async function queryUtxosViaRpc(address) {
  // Use scantxoutset to quickly find UTXOs for a specific address.
  // This requires bitcoind >= 0.17.0
  const scanObject = [`addr(${address})`];
  try {
    const res = await rpcCall("scantxoutset", ["start", scanObject]);
    // res | { start_time, success, txouts, total_amount, unspents: [{txid, vout, scriptPubKey, amount, height}], ... }
    return res.unspents || [];
  } catch (err) {
    // older nodes or disallowed RPC call may fail — bubble up
    throw err;
  }
}

async function queryUtxosBlockstream(address) {
  // Blockstream public API
  const url = `https://blockstream.info/api/address/${address}/utxo`;
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`Blockstream API error ${res.status}`);
  }
  const js = await res.json();
  // blockstream returns [{txid, vout, value, status:{confirmed,...}}]
  return js.map(u => ({
    txid: u.txid,
    vout: u.vout,
    amount: u.value / 1e8,
    value_sats: u.value,
    height: u.status?.block_height ?? 0,
    scriptPubKey: null,
  }));
}

function formatUtxo(utxo) {
  return `${utxo.txid}:${utxo.vout} sats=${Math.round((utxo.amount ?? utxo.value_sats/1e8)*1e8)}`;
}

async function main() {
  // 1) Validate WIF
  let keyPair;
  try {
    keyPair = ECPair.fromWIF(WIF, network);
  } catch (err) {
    console.error("Invalid WIF or unsupported network/compression:", err.message || err);
    process.exit(1);
  }

  console.log("WIF seems valid.");
  console.log("Compressed:", !!keyPair.compressed);
  console.log("Public key (hex):", keyPair.publicKey.toString("hex"));

  // 2) Derive addresses
  const addrs = deriveAddressesFromKeyPair(keyPair);
  console.log("\nDerived addresses:");
  console.log(" P2WPKH (bech32):   ", addrs.p2wpkh);
  console.log(" P2SH-P2WPKH:       ", addrs.p2shwpkh);
  console.log(" P2PKH (legacy):    ", addrs.p2pkh);

  // 3) Query UTXOs for each address (try bech32 first)
  let utxos = [];
  const addressesToCheck = [addrs.p2wpkh, addrs.p2shwpkh, addrs.p2pkh];
  console.log("\nChecking UTXOs for derived addresses...");

  for (const addr of addressesToCheck) {
    if (!addr) continue;
    console.log(`\n -> Address: ${addr}`);
    try {
      let found = [];
      if (rpcBase) {
        try {
          const res = await queryUtxosViaRpc(addr);
          found = (res || []).map(u => ({
            txid: u.txid,
            vout: u.vout,
            amount: u.amount, // scantxoutset returns amount in BTC
            value_sats: Math.round(u.amount * 1e8),
            scriptPubKey: u.scriptPubKey,
          }));
        } catch (err) {
          console.warn(" RPC scantxoutset failed, falling back to Blockstream:", err.message || err);
          const bs = await queryUtxosBlockstream(addr);
          found = bs;
        }
      } else {
        const bs = await queryUtxosBlockstream(addr);
        found = bs;
      }

      if (found.length === 0) {
        console.log("  No UTXOs found for this address.");
      } else {
        console.log("  UTXOs:");
        found.forEach(u => console.log("   -", formatUtxo(u)));
        utxos = utxos.concat(found.map(u => ({ ...u, address: addr })));
      }
    } catch (err) {
      console.error("  Error checking address:", err.message || err);
    }
  }

  if (utxos.length === 0) {
    console.log("\nNo UTXOs found for any derived address. The key is valid, but has no spendable funds (or addresses were used with other scripts).");
    process.exit(0);
  }

  // 4) If utxos exist and no dest provided, prompt user and exit with info
  console.log(`\nTotal UTXOs found: ${utxos.length}. Total sats: ${utxos.reduce((s,u)=>s+(u.value_sats||0),0)}`);

  if (!dest) {
    console.log("\nNo --dest provided. To test signing/sweep, rerun with --dest <destination_address>.");
    process.exit(0);
  }

  // 5) Build PSBT to sweep all to dest (estimate fee simple)
  // We'll use a simple fee estimation: feePerByte sats. (You might want to replace with better fee estimation)
  const feePerByte = 5; // sats/byte (conservative default). Adjust as needed or query RPC fee estimates.
  // create psbt
  const psbt = new bitcoin.Psbt({ network });

  // Add inputs
  let totalInputSats = 0;
  for (const u of utxos) {
    // To build a PSBT we need the full output script & value in sats.
    // Blockstream doesn't return scriptPubKey in this call. For P2WPKH / P2SH-P2WPKH / P2PKH we can reconstruct output script from address.
    const value = u.value_sats || Math.round((u.amount || 0) * 1e8);
    totalInputSats += value;

    // For segwit inputs we need witnessUtxo: { script, value }
    const scriptPubKey = bitcoin.address.toOutputScript(u.address, network);

    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      witnessUtxo: {
        script: scriptPubKey,
        value: value,
      },
      // For P2SH-P2WPKH we need redeemScript too
      ...(u.address === addrs.p2shwpkh ? {
        redeemScript: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(keyPair.publicKey), network }).output
      } : {})
    });
  }

  // Rough tx size estimate: inputs * 68 + outputs * 34 + 10
  const estVBytes = Math.ceil(utxos.length * 68 + 1 * 34 + 10);
  const fee = Math.max(1000, Math.ceil(estVBytes * feePerByte)); // at least 1000 sats
  const sendSats = totalInputSats - fee;
  if (sendSats <= 0) {
    console.error("After fee the output amount is non-positive. Increase feePerByte or check UTXOs.");
    process.exit(1);
  }

  psbt.addOutput({
    address: dest,
    value: sendSats,
  });

  // 6) Sign inputs
  for (let i = 0; i < utxos.length; i++) {
    try {
      psbt.signInput(i, keyPair);
    } catch (err) {
      console.error("Failed to sign input", i, err.message || err);
      process.exit(1);
    }
  }

  // Validate signatures
  try {
    psbt.validateSignaturesOfAllInputs();
  } catch (err) {
    console.error("Signature validation failed:", err.message || err);
    process.exit(1);
  }

  psbt.finalizeAllInputs();
  const txHex = psbt.extractTransaction().toHex();

  console.log("\nSigned sweep transaction hex (not broadcast):");
  console.log(txHex);
  console.log(`\nTotal input sats: ${totalInputSats}, fee sats: ${fee}, send sats: ${sendSats}`);

  if (doBroadcast) {
    if (!rpcBase) {
      console.error("Cannot broadcast because RPC is not configured. Set BTC_RPC_HOST, BTC_RPC_USER, BTC_RPC_PASS.");
      process.exit(1);
    }
    try {
      const txid = await rpcCall("sendrawtransaction", [txHex]);
      console.log("Broadcasted txid:", txid);
    } catch (err) {
      console.error("Broadcast failed:", err.message || err);
      process.exit(1);
    }
  } else {
    console.log("\nTo broadcast, re-run with --broadcast and configure RPC env vars (BTC_RPC_HOST, BTC_RPC_USER, BTC_RPC_PASS).");
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
