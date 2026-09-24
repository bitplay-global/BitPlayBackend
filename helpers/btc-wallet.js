// helpers/btc-wallet.js
import * as bitcoin from "bitcoinjs-lib";
import * as bip39 from "bip39";
import * as bip32 from "bip32";
import * as ecc from "tiny-secp256k1";

const network = bitcoin.networks.testnet;
const BIP32 = bip32.BIP32Factory(ecc);

// Generate mnemonic
const mnemonic = bip39.generateMnemonic();
console.log("Mnemonic:", mnemonic);

// Derive seed and root
const seed = await bip39.mnemonicToSeed(mnemonic);
const root = BIP32.fromSeed(seed, network);

// Standard BIP44 path for Bitcoin testnet
const path = "m/44'/1'/0'/0/0";
const child = root.derivePath(path);

// FIX: Convert Uint8Array -> Buffer
const { address } = bitcoin.payments.p2wpkh({
  pubkey: Buffer.from(child.publicKey),
  network,
});

console.log("Testnet BTC Address:", address);
console.log("Private Key (WIF):", child.toWIF());
