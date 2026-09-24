// routes/api_routes/alchemy_deposit.js
import express from "express";
import WalletAddress from "../../models/WalletAddress.js";
import DerivationCounter from "../../models/DerivationCounter.js";
import { ethers, Wallet as EthersWallet } from "ethers";
import * as bitcoin from "bitcoinjs-lib";
import BIP32Factory from "bip32";
import * as ecc from "tiny-secp256k1";
import { subscribeAddress } from "../../webhooks/alchemyWatcher.js";
import { registerBtcAddress } from "../../webhooks/btcWatcher.js";

const router = express.Router();

// Deposit keys come only from the environment.
//
// A 12-word recovery phrase used to be hardcoded here, with no override. It
// controls every user's BSC (USDT/BNB/USDC) deposit address and is in git
// history: treat it as compromised and move those funds.
//
// Prefer EVM_XPUB: address issuing needs only a public key. It is the extended
// PUBLIC key of the node the phrase-based code derives from, i.e.
//   HDNodeWallet.fromPhrase(phrase).derivePath("44'/60'/0'").neuter().extendedKey
// Note that fromPhrase() starts at m/44'/60'/0'/0/0, so live addresses sit at
// m/44'/60'/0'/0/0/44'/60'/0'/0/idx -- not the standard m/44'/60'/0'/0/idx.
const EVM_XPUB = process.env.EVM_XPUB || "";
const EVM_MNEMONIC = process.env.EVM_MNEMONIC || "";

// Account key for deriving user deposit addresses. Deriving an address needs
// only the PUBLIC key, so set BTC_XPUB and keep the private key off the server.
// BTC_XPRV is still accepted so existing deployments keep working until then.
//
// A mainnet xprv used to be hardcoded here as a fallback. That key controls
// every user's deposit address and is in git history: treat it as compromised.
const BTC_ACCOUNT_KEY = process.env.BTC_XPUB || process.env.BTC_XPRV || "";
if (!BTC_ACCOUNT_KEY) {
  console.error("[Deposits] BTC_XPUB / BTC_XPRV not set: new BTC deposit addresses cannot be issued.");
}

// init EVM wallet
let evmHdNode = null;
let evmSingleWallet = null;
let evmAccountXpubNode = null;
if (EVM_XPUB) {
  evmAccountXpubNode = ethers.HDNodeWallet.fromExtendedKey(EVM_XPUB);
} else if (EVM_MNEMONIC) {
  evmHdNode = ethers.HDNodeWallet.fromPhrase(EVM_MNEMONIC);
} else if (process.env.EVM_PRIVATE_KEY) {
  evmSingleWallet = new EthersWallet(process.env.EVM_PRIVATE_KEY);
}

// init BTC
const bip32 = BIP32Factory(ecc);
const btcNetwork = bitcoin.networks.bitcoin;
let btcRootNode = BTC_ACCOUNT_KEY ? bip32.fromBase58(BTC_ACCOUNT_KEY, btcNetwork) : null;

// A public account key (xpub) cannot do the hardened steps in m/84'/0'/0', so it
// is taken to BE that account node and only the non-hardened 0/idx is derived.
// A private root key (xprv) derives the full path. Both give the same address
// for the same idx, so switching BTC_XPRV -> BTC_XPUB does not move anyone's
// deposit address.
const BTC_KEY_IS_PUBLIC = Boolean(btcRootNode && btcRootNode.isNeutered());

function deriveBtcDepositAddress(idx) {
  if (!btcRootNode) throw new Error("BTC deposit key not configured");
  const derivationPath = `84'/0'/0'/0/${idx}`;
  const child = BTC_KEY_IS_PUBLIC
    ? btcRootNode.derivePath(`0/${idx}`)
    : btcRootNode.derivePath(derivationPath);
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(child.publicKey),
    network: btcNetwork,
  });
  return { address, derivationPath };
}

function deriveEvmDepositAddress(idx) {
  if (evmAccountXpubNode) {
    // Same address as the phrase path below, without holding the phrase.
    return { address: evmAccountXpubNode.derivePath(`0/${idx}`).address, derivationPath: `44'/60'/0'/0/${idx}` };
  }
  if (evmHdNode) {
    const derivationPath = `44'/60'/0'/0/${idx}`;
    return { address: evmHdNode.derivePath(derivationPath).address, derivationPath };
  }
  if (evmSingleWallet) return { address: evmSingleWallet.address, derivationPath: undefined };
  throw new Error("No EVM mnemonic/private key");
}

/**
 * Helpers
 */
async function getNextIndexForChain(chain) {
  const counter = await DerivationCounter.findOneAndUpdate(
    { chain },
    { $inc: { nextIndex: 1 } },
    { upsert: true, returnDocument: "after" }
  ).lean();
  return counter.nextIndex - 1;
}

/**
 * GET /deposit-address/:userId/:asset
 */
router.get("/:userId/:asset", async (req, res) => {
  try {
    const { userId } = req.params;
    const asset = String(req.params.asset || "").toUpperCase();

    let chain;
    if (["BNB", "USDT", "USDC"].includes(asset)) chain = "bsc";
    else if (asset === "BTC") chain = "btc";
    else return res.status(400).json({ error: "Unsupported asset" });

    // existing?
    const existing = await WalletAddress.findOne({ userId, asset, chain });
    if (existing) return res.json({ address: existing.address });

    const idx = await getNextIndexForChain(chain);
    let address, derivationPath;

    if (chain === "bsc") {
      ({ address, derivationPath } = deriveEvmDepositAddress(idx));
      // ensure this address is subscribed in Alchemy webhook
      await subscribeAddress(address);
    } else if (chain === "btc") {
      // Core-compatible derivation path: m/84'/0'/0'/0/idx
      ({ address, derivationPath } = deriveBtcDepositAddress(idx));
      registerBtcAddress(address);
    }

    const doc = await WalletAddress.create({
      userId,
      chain,
      asset,
      address,
      derivationPath,
      idx,
    });

    // The private key used to be returned here, to whoever first asked for a
    // user's address -- no authentication -- and logged and stored in plaintext.
    // Only the address leaves the server now.
    return res.json({ address: doc.address });
  } catch (err) {
    console.error("deposit address error:", err);
    return res.status(500).json({ error: "Failed to allocate address" });
  }
});

router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // Supported assets
    const assets = ["BTC", "BNB", "USDT", "USDC"];
    const results = {};

    for (const asset of assets) {
      let chain;
      if (["BNB", "USDT", "USDC"].includes(asset)) chain = "bsc";
      else if (asset === "BTC") chain = "btc";
      else continue;

      // Check if wallet already exists
      let existing = await WalletAddress.findOne({ userId, asset, chain });
      if (existing) {
        results[asset] = existing.address;
        continue;
      }

      // Otherwise, create new wallet
      const idx = await getNextIndexForChain(chain);
      let address, derivationPath;

      if (chain === "bsc") {
        ({ address, derivationPath } = deriveEvmDepositAddress(idx));
        await subscribeAddress(address);
      } else if (chain === "btc") {
        ({ address, derivationPath } = deriveBtcDepositAddress(idx));
        registerBtcAddress(address);
      }

      const doc = await WalletAddress.create({
        userId,
        chain,
        asset,
        address,
        derivationPath,
        idx,
      });

      results[asset] = doc.address;
    }

    return res.json(results);
  } catch (err) {
    console.error("deposit address error:", err);
    return res.status(500).json({ error: "Failed to allocate address" });
  }
});

export default router;
