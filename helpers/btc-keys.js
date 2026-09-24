// helpers/btc-keys.js
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
import { randomBytes } from "crypto";
import BIP32Factory from "bip32";

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc); // <--- this is the key fix

// Generate a random seed (64 bytes)
const seed = randomBytes(64);

// Derive master key
const root = bip32.fromSeed(seed, bitcoin.networks.bitcoin);

// Derive account (BIP84: m/84'/0'/0')
const account = root.deriveHardened(84).deriveHardened(0).deriveHardened(0);

console.log("XPRV:", account.toBase58());              // extended private key (keep safe!)
console.log("XPUB:", account.neutered().toBase58());   // extended public key (safe for backend)
