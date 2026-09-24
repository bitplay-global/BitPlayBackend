// derive-child.js
// Usage examples (see below):
//   node --input-type=cli derive-child.js "<xprv>" 0 5
//   node derive-child.js           # reads XPRV env var and uses defaults

import BIP32Factory from "bip32";
import * as ecc from "tiny-secp256k1";
import * as bitcoin from "bitcoinjs-lib";

// init bip32 with secp
const bip32 = BIP32Factory(ecc);
const network = bitcoin.networks.bitcoin; // change to bitcoin.networks.testnet for testnet

function usageAndExit() {
  console.log(`
Usage:
  - Provide xprv as a CLI arg:
      node derive-child.js "<xprv>" <change> <index> [purpose] [coin] [account]
    Example:
      node derive-child.js "xprv9s21Z..." 0 5 84 0 0
    This derives path: m/84'/0'/0'/0/5

  - Or set XPRV environment variable and run with change/index:
      XPRV="xprv9s21Z..." node derive-child.js 0 5

  - If your provided xprv is already at account-level (e.g. m/84'/0'/0'),
    you can pass baseIsAccount=true by prefixing change with "A:":
      node derive-child.js "xprv..." A:0 5
    which will only derive 0/5 (i.e. relative derivation from the account xprv).

  Notes:
    - purpose defaults to 84 (native segwit - wpkh). Adjust if your wallet used 44/49/86 etc.
    - coin defaults to 0 (BTC). For testnet use coin 1 and set network appropriately.
  `);
  process.exit(1);
}

/**
 * Parse CLI args (very small helper)
 * arg0: xprv (or will use process.env.XPRV)
 * arg1: change (0 external / 1 internal) OR "A:change" to indicate base is account-level xprv
 * arg2: index
 * optional: purpose coin account
 */
function parseArgs() {
  const argv = process.argv.slice(2);
  let xprv = process.env.XPRV || null;
  if (argv.length >= 1 && argv[0]) xprv = argv[0];

  if (!xprv) {
    console.error("No xprv provided as arg or XPRV env var.");
    usageAndExit();
  }

  if (argv.length < 3 && !process.env.XPRV) {
    console.error("If not using XPRV env var, you must provide xprv, change and index.");
    usageAndExit();
  }

  // determine if change is relative or absolute
  // allow form A:0 to indicate account-level xprv (so derive change/index only)
  const rawChange = argv[1] ?? "0";
  const accountLevelFlag = String(rawChange).startsWith("A:");
  const change = accountLevelFlag ? parseInt(rawChange.slice(2), 10) : parseInt(rawChange, 10);

  const index = argv[2] !== undefined ? parseInt(argv[2], 10) : 0;

  const purpose = argv[3] !== undefined ? parseInt(argv[3], 10) : 84;
  const coin = argv[4] !== undefined ? parseInt(argv[4], 10) : 0;
  const account = argv[5] !== undefined ? parseInt(argv[5], 10) : 0;

  if (Number.isNaN(change) || Number.isNaN(index) || Number.isNaN(purpose) || Number.isNaN(coin) || Number.isNaN(account)) {
    console.error("Invalid numeric argument");
    usageAndExit();
  }

  return { xprv, accountLevelFlag, purpose, coin, account, change, index };
}

function deriveAndShow({ xprv, accountLevelFlag, purpose, coin, account, change, index }) {
  // create bip32 node from xprv
  let root;
  try {
    root = bip32.fromBase58(xprv, network);
  } catch (e) {
    console.error("Failed to parse xprv. Make sure it's a valid xprv for the configured network.");
    console.error(e.message);
    process.exit(1);
  }

  // Build derivation path:
  // If accountLevelFlag is true, xprv is assumed to already be at m/<purpose>'/<coin>'/<account>'
  // In that case we'll derive: <change>/<index>
  // Otherwise derive full path: m/<purpose>'/<coin>'/<account>'/<change>/<index>
  const path = accountLevelFlag
    ? `${change}/${index}`
    : `m/${purpose}'/${coin}'/${account}'/${change}/${index}`;

  const child = accountLevelFlag ? root.derive(change).derive(index) : root.derivePath(path);

  if (!child.privateKey) {
    console.error("Derived node does not contain a private key (maybe you passed an xpub?). Provide an xprv.");
    process.exit(1);
  }

  // Private key hex
  const privHex = child.privateKey.toString("hex");

  // WIF (bip32 nodes usually expose toWIF)
  let wif = null;
  try {
    if (typeof child.toWIF === "function") {
      wif = child.toWIF();
    }
  } catch (e) {
    // ignore if not available
    wif = null;
  }

  // Generate bech32 (p2wpkh) address using the child public key
  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(child.publicKey),
    network,
  });

  const address = p2wpkh.address;

  console.log("=== DERIVATION RESULT ===");
  console.log("Derivation path used:", path);
  console.log("Address (p2wpkh/bech32):", address);
  console.log("Private key (hex):", privHex);
  if (wif) console.log("Private key (WIF):", wif);
  console.log("=========================");
  console.log("");
  console.log("IMPORTANT: Keep this output secret. Do not paste it anywhere public.");
}

// run
const params = parseArgs();
deriveAndShow(params);
