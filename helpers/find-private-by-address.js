// find-private-by-address.js
// Usage examples:
//
// 1) Use XPRV env var (recommended) and search default range 0..100:
//    export XPRV="xprv9s21Z..."
//    node find-private-by-address.js bc1qedzf2qx3m6f4thfhgwn3h5dt2226f3t3tyzgaf
//
// 2) Provide xprv as first arg (less safe - appears in shell history):
//    node find-private-by-address.js "xprv9s21Z..." bc1q... 0 0 500 p2wpkh
//
// CLI params (positional):
//   [0] xprv or (omit to use XPRV env var)
//   [1] targetAddress (required if xprv provided or not)
//   [2] change (0 or 1) default 0
//   [3] startIndex default 0
//   [4] endIndex default 100
//   [5] scriptType default p2wpkh (options: p2wpkh, p2pkh, p2sh-p2wpkh)
//   [6] accountLevel flag: "A" to indicate the provided xprv is account-level (so derive change/index only)
//
// Example (search external addresses 0..100 for bech32):
//   export XPRV="xprv9..."
//   node find-private-by-address.js bc1q... 0 0 100 p2wpkh
//
// NOTE: Searching a large range (thousands) will take time and CPU. Keep range reasonable.

import BIP32Factory from "bip32";
import * as ecc from "tiny-secp256k1";
import * as bitcoin from "bitcoinjs-lib";

const bip32 = BIP32Factory(ecc);
const network = bitcoin.networks.bitcoin; // change to testnet network if needed

function usageAndExit() {
  console.log(`
Usage:
  - Recommended: set XPRV environment variable and pass the target address:
      export XPRV="xprv9..."
      node find-private-by-address.js <targetAddress> [change=0] [start=0] [end=100] [scriptType=p2wpkh] [accountFlag]
  - Or pass xprv as first arg (less secure - command history):
      node find-private-by-address.js <xprv> <targetAddress> <change> <start> <end> <scriptType> [accountFlag]

scriptType options:
  - p2wpkh         (native segwit / bech32)  — matches wpkh(...) / wpkh descriptors
  - p2pkh          (legacy)                  — matches pkh(...)
  - p2sh-p2wpkh    (wrapped segwit)          — matches sh(wpkh(...))

accountFlag:
  - pass "A" if the provided xprv is account-level (e.g. m/84'/0'/0'), so the script derives change/index only.
`);
  process.exit(1);
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let xprv = process.env.XPRV || null;
  let targetAddress;
  let argIndex = 0;

  if (argv.length === 0 && !xprv) {
    usageAndExit();
  }

  // If first arg looks like an xprv, treat it as xprv
  if (argv.length > 0 && String(argv[0]).startsWith("xprv")) {
    xprv = argv[0];
    argIndex = 1;
  }

  // next arg must be targetAddress
  targetAddress = argv[argIndex];
  if (!targetAddress) usageAndExit();
  argIndex++;

  const change = argv[argIndex] !== undefined ? parseInt(argv[argIndex++], 10) : 0;
  const start = argv[argIndex] !== undefined ? parseInt(argv[argIndex++], 10) : 0;
  const end = argv[argIndex] !== undefined ? parseInt(argv[argIndex++], 10) : 100;
  const scriptType = argv[argIndex] !== undefined ? argv[argIndex++] : "p2wpkh";
  const accountFlag = argv[argIndex] !== undefined ? argv[argIndex] === "A" : false;

  // Basic validation
  if (!xprv) {
    console.error("Missing xprv: set XPRV environment variable or pass xprv as first argument.");
    process.exit(1);
  }
  if (!targetAddress) usageAndExit();
  if (![0,1].includes(change)) {
    console.error("change must be 0 or 1");
    process.exit(1);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < 0 || end < start) {
    console.error("Invalid start/end indices");
    process.exit(1);
  }
  if (!["p2wpkh","p2pkh","p2sh-p2wpkh"].includes(scriptType)) {
    console.error("Unsupported scriptType:", scriptType);
    process.exit(1);
  }

  return { xprv, targetAddress, change, start, end, scriptType, accountFlag };
}

function deriveAddressFromNode(node, scriptType) {
  // node: bip32 child node (has publicKey)
  // ensure Buffer for bitcoinjs-lib
  const pubkeyBuf = Buffer.from(node.publicKey);

  if (scriptType === "p2wpkh") {
    const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: pubkeyBuf, network });
    return p2wpkh.address;
  } else if (scriptType === "p2pkh") {
    const p2pkh = bitcoin.payments.p2pkh({ pubkey: pubkeyBuf, network });
    return p2pkh.address;
  } else if (scriptType === "p2sh-p2wpkh") {
    const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: pubkeyBuf, network });
    const p2sh = bitcoin.payments.p2sh({ redeem: p2wpkh, network });
    return p2sh.address;
  } else {
    throw new Error("unsupported script type");
  }
}

function showFoundDetails(child, path, idx, address) {
  // child should contain privateKey
  const privHex = child.privateKey ? child.privateKey.toString("hex") : null;
  let wif = null;
  try {
    if (typeof child.toWIF === "function") wif = child.toWIF();
  } catch (e) {
    // ignore
  }

  console.log("=== MATCH FOUND ===");
  console.log("Derivation path:", path);
  console.log("Index:", idx);
  console.log("Address (derived):", address);
  if (privHex) console.log("Private key (hex):", privHex);
  if (wif) console.log("Private key (WIF):", wif);
  console.log("===================");
}

async function main() {
  const { xprv, targetAddress, change, start, end, scriptType, accountFlag } = parseArgs();

  // Create root from xprv
  let root;
  try {
    root = bip32.fromBase58(xprv, network);
  } catch (e) {
    console.error("Failed to parse xprv:", e.message);
    process.exit(1);
  }

  console.log(`Searching for address ${targetAddress}`);
  console.log(`scriptType=${scriptType} change=${change} range=${start}..${end} accountLevel=${accountFlag}`);

  // If accountFlag true, we assume provided xprv = account-level (e.g. m/84'/0'/0')
  // and will derive change/index relative to that.
  // Otherwise we will derive full path: m/84'/0'/0'/<change>/<index>
  // NOTE: purpose/coin/account are currently fixed to 84/0/0. If you need different purpose/coin/account,
  // Descriptors indicate wpkh m/84'/0'/0'/0/* by default.
  const purpose = 84;
  const coin = 0;
  const account = 0;

  for (let idx = start; idx <= end; idx++) {
    let child;
    let path;
    try {
      if (accountFlag) {
        // derive change/index relative to provided xprv
        child = root.derive(change).derive(idx);
        path = `${change}/${idx}`;
      } else {
        path = `m/${purpose}'/${coin}'/${account}'/${change}/${idx}`;
        child = root.derivePath(path);
      }

      // make sure child has pubkey
      if (!child.publicKey) {
        // this shouldn't happen for xprv-derived nodes, but guard anyway
        continue;
      }

      const derivedAddress = deriveAddressFromNode(child, scriptType);

      if (derivedAddress === targetAddress) {
        // ensure we have private key
        if (!child.privateKey) {
          console.error("Derived child does not contain a private key (maybe you provided xpub).");
          process.exit(1);
        }
        showFoundDetails(child, path, idx, derivedAddress);
        process.exit(0);
      }

      // optional: every 1000 iterations print progress
      if ((idx - start) % 1000 === 0 && idx !== start) {
        console.log(`checked up to index ${idx}...`);
      }
    } catch (e) {
      // non-fatal for single index; but show if it's unexpected
      console.error(`error deriving index ${idx}:`, e.message);
    }
  }

  console.log("Search complete. No match found in the provided range.");
  process.exit(2);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
