import fs from "fs";
import inquirer from "inquirer";
import axios from "axios";
import * as bitcoin from "bitcoinjs-lib";
import ECPairFactory from "ecpair";
import * as ecc from "tiny-secp256k1";

// Setup ECPair for bitcoinjs-lib v6+
const ECPair = ECPairFactory(ecc);

const ALCHEMY_URL = "https://bitcoin-testnet.g.alchemy.com/v2/Ej90ndV1bIQ8B03IM0JlA";
const network = bitcoin.networks.testnet;
const WALLET_FILE = "wallets.json";

// Load wallets from file
function loadWallets() {
  if (fs.existsSync(WALLET_FILE)) {
    return JSON.parse(fs.readFileSync(WALLET_FILE, "utf-8"));
  }
  return [];
}

// Save wallets to file
function saveWallets(wallets) {
  fs.writeFileSync(WALLET_FILE, JSON.stringify(wallets, null, 2));
}

// Generate new wallet
function generateWallet(wallets) {
  const keyPair = ECPair.makeRandom({ network });
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network,
  });

  const w = { address, privateKey: keyPair.toWIF() };
  wallets.push(w);
  saveWallets(wallets);
  console.log("New wallet created:", address);
  return w;
}

// Import wallet from WIF
function importWallet(wallets, wif) {
  try {
    const keyPair = ECPair.fromWIF(wif, network);
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: Buffer.from(keyPair.publicKey),
      network,
    });
    const w = { address, privateKey: wif };
    wallets.push(w);
    saveWallets(wallets);
    console.log("Imported wallet:", address);
    return w;
  } catch (err) {
    console.error("Invalid WIF private key for testnet!");
  }
}

// List wallets
function listWallets(wallets) {
  if (!wallets.length) console.log("No wallets saved yet.");
  else wallets.forEach((w, i) => console.log(`${i + 1}. ${w.address}`));
}

// Get balance of an address
async function getBalance(address) {
  try {
    const res = await axios.post(ALCHEMY_URL, {
      jsonrpc: "2.0",
      id: 1,
      method: "getaddressutxos",
      params: [{ addresses: [address] }],
    });

    const utxos = res.data.result;
    if (!utxos || utxos.length === 0) return 0;

    const balance = utxos.reduce((sum, u) => sum + u.satoshis, 0);
    return balance;
  } catch (err) {
    console.error("Error fetching balance:", err.response?.data?.error?.message || err.message);
    return 0;
  }
}

// Send transaction
async function sendTransaction(sender, recipient, amountSats) {
  const utxosRes = await axios.post(ALCHEMY_URL, {
    jsonrpc: "2.0",
    id: 1,
    method: "getaddressutxos",
    params: [{ addresses: [sender.address] }],
  });

  const utxos = utxosRes.data.result;
  if (!utxos || utxos.length === 0) throw new Error("No UTXOs to spend.");

  const psbt = new bitcoin.Psbt({ network });
  let totalInput = 0;

  for (const utxo of utxos) {
    psbt.addInput({
      hash: utxo.txid,
      index: utxo.outputIndex,
      witnessUtxo: {
        script: Buffer.from(utxo.script, "hex"),
        value: utxo.satoshis,
      },
    });
    totalInput += utxo.satoshis;
    if (totalInput >= amountSats + 500) break; // leave fee
  }

  psbt.addOutput({ address: recipient, value: amountSats });
  const fee = 500;
  const change = totalInput - amountSats - fee;
  if (change > 0) psbt.addOutput({ address: sender.address, value: change });

  const keyPair = ECPair.fromWIF(sender.privateKey, network);
  psbt.signAllInputs(keyPair);
  psbt.finalizeAllInputs();

  const rawTx = psbt.extractTransaction().toHex();
  const sendRes = await axios.post(ALCHEMY_URL, {
    jsonrpc: "2.0",
    id: 1,
    method: "sendrawtransaction",
    params: [rawTx],
  });

  return sendRes.data.result;
}

// CLI menu
async function main() {
  const wallets = loadWallets();

  while (true) {
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "What do you want to do?",
        choices: [
          "Add new wallet (generate)",
          "Import wallet (WIF key)",
          "List wallets",
          "Get balance of all wallets",
          "Get balance of one wallet",
          "Make a transfer",
          "Exit",
        ],
      },
    ]);

    if (action === "Add new wallet (generate)") generateWallet(wallets);
    else if (action === "Import wallet (WIF key)") {
      const { wif } = await inquirer.prompt([{ type: "input", name: "wif", message: "Enter WIF private key:" }]);
      importWallet(wallets, wif.trim());
    } else if (action === "List wallets") listWallets(wallets);
    else if (action === "Get balance of all wallets") {
      for (const w of wallets) {
        const bal = await getBalance(w.address);
        console.log(`${w.address}: ${bal} sats`);
      }
    } else if (action === "Get balance of one wallet") {
      if (!wallets.length) { console.log("No wallets available."); continue; }
      const { index } = await inquirer.prompt([
        {
          type: "list",
          name: "index",
          message: "Select a wallet:",
          choices: wallets.map((w, i) => ({ name: `${i + 1}. ${w.address}`, value: i })),
        },
      ]);
      const bal = await getBalance(wallets[index].address);
      console.log(`${wallets[index].address} balance: ${bal} sats`);
    } else if (action === "Make a transfer") {
      if (!wallets.length) { console.log("No wallets available."); continue; }
      const { senderIndex } = await inquirer.prompt([
        {
          type: "list",
          name: "senderIndex",
          message: "Select sender wallet:",
          choices: wallets.map((w, i) => ({ name: `${i + 1}. ${w.address}`, value: i })),
        },
      ]);
      const { recipient, amount } = await inquirer.prompt([
        { type: "input", name: "recipient", message: "Recipient address:" },
        { type: "number", name: "amount", message: "Amount (sats):" },
      ]);
      try {
        const txid = await sendTransaction(wallets[senderIndex], recipient, amount);
        console.log("Transaction sent! TXID:", txid);
      } catch (err) {
        console.error("Transfer failed:", err.message);
      }
    } else if (action === "Exit") { console.log("Byeee"); break; }
  }
}

main();
