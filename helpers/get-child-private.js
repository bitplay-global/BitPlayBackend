#!/usr/bin/env node
import * as bitcoin from "bitcoinjs-lib";
import BIP32Factory from "bip32";
import * as ecc from "tiny-secp256k1";

const bip32 = BIP32Factory(ecc);
const network = bitcoin.networks.bitcoin;

/**
 * Derives a child wallet from an account-level xprv and index
 * @param {string} accountXprv - account-level xprv (e.g., m/84'/0'/0')
 * @param {number} idx - child wallet index
 * @param {string} scriptType - p2wpkh, p2pkh, or p2sh
 * @returns {object} - { address, privateKey }
 */
function deriveChildWallet(accountXprv, idx, scriptType = "p2wpkh") {
  const accountNode = bip32.fromBase58(accountXprv, network);

  // Derive child node exactly as backend did (xpub.derive(idx))
  const childNode = accountNode.derive(idx);

  let payment;
  switch (scriptType) {
    case "p2wpkh":
      payment = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(childNode.publicKey), network });
      break;
    case "p2pkh":
      payment = bitcoin.payments.p2pkh({ pubkey: Buffer.from(childNode.publicKey), network });
      break;
    case "p2sh":
      payment = bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(childNode.publicKey), network }),
        network,
      });
      break;
    default:
      throw new Error("Unsupported script type: " + scriptType);
  }

  return {
    address: payment.address,
    privateKey: childNode.toWIF(),
    publicKey: childNode.publicKey.toString("hex"),
  };
}

// --- CLI ---
async function main() {
  const [,, accountXprv, idxArg, scriptTypeArg] = process.argv;

  if (!accountXprv || !idxArg) {
    console.error("Usage: node get-child-private.js <account-xprv> <idx> [scriptType]");
    process.exit(1);
  }

  const idx = parseInt(idxArg, 10);
  const scriptType = scriptTypeArg || "p2wpkh";

  const child = deriveChildWallet(accountXprv, idx, scriptType);

  console.log("===== CHILD WALLET INFO =====");
  console.log("Child index:", idx);
  console.log("Address:", child.address);
  console.log("Private key (WIF):", child.privateKey);
  console.log("Public key (hex):", child.publicKey);
  console.log("=============================");
}

main().catch(console.error);
