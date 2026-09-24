#!/usr/bin/env node
import ecc from '@bitcoinerlab/secp256k1';
import { BIP32Factory } from 'bip32';
import bitcoinPkg from 'bitcoinjs-lib'; // CommonJS import
import ECPairFactory from 'ecpair';

const { payments } = bitcoinPkg;
const ECPair = ECPairFactory(ecc); // now from @bitcoinerlab/secp256k1

const BIP32 = BIP32Factory(ecc);

// ===== HARDCODED VALUES =====
const accountXprv = process.env.BTC_XPRV || process.argv[2];
if (!accountXprv) { console.error("Usage: BTC_XPRV=<xprv> node helpers/child-priv-key.js  (or pass it as the first argument)"); process.exit(1); } 
const derivationPath = "84h/0h/0h";
const childIndex = 10;                  // child index to derive
const type = "wpkh";                     // address type: pkh | wpkh | shwpkh | tr
// =============================

function parseDerivation(part) {
  if (part.endsWith("'") || part.endsWith("h")) {
    return parseInt(part.slice(0, -1), 10) + 0x80000000;
  }
  return parseInt(part, 10);
}

// Create root node from account xprv
const node = BIP32.fromBase58(accountXprv);

// Derive the branch (account path)
const pathParts = derivationPath.split("/");
let branchNode = node;
for (const part of pathParts) {
  const idx = parseDerivation(part);
  if (idx >= 0x80000000) branchNode = branchNode.deriveHardened(idx - 0x80000000);
  else branchNode = branchNode.derive(idx);
}

// Derive child
const child = branchNode.derive(childIndex);
if (!child.privateKey) {
  console.error("ERROR: Derived child does not have a private key!");
  process.exit(1);
}

// Keys
const privateKey = child.privateKey;
const publicKey = Buffer.from(child.publicKey);

// Generate address
let address;
switch (type) {
  case 'pkh':
    address = payments.p2pkh({ pubkey: publicKey }).address;
    break;
  case 'wpkh':
    address = payments.p2wpkh({ pubkey: publicKey }).address;
    break;
  case 'shwpkh':
    address = payments.p2sh({ redeem: payments.p2wpkh({ pubkey: publicKey }) }).address;
    break;
  case 'tr':
    address = payments.p2tr({ internalPubkey: publicKey.slice(1, 33) }).address;
    break;
  default:
    console.error('Unsupported type. Use: pkh, wpkh, shwpkh, tr');
    process.exit(1);
}

// Private key in WIF
const wif = ECPair.fromPrivateKey(privateKey).toWIF();

// Output
console.log("===== CHILD WALLET INFO =====");
console.log("Account xprv path:", accountXprv + "/" + derivationPath);
console.log("Child index:", childIndex);
console.log("Address:", address);
console.log("Private key (WIF):", wif);
console.log("Public key (hex):", publicKey.toString('hex'));
console.log("=============================");
