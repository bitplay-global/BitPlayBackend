// routes/api_routes/alchemy_deposit.js
import express from "express";
import WalletAddress from "../../models/WalletAddress.js";
import DerivationCounter from "../../models/DerivationCounter.js";
import { ethers, Wallet as EthersWallet } from "ethers";
import { resolveBtcAccount, deriveBtcAddress } from "../../helpers/btcDepositKey.js";
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
// See helpers/btcDepositKey.js for the accepted forms and the consistency check.
//
// A mainnet xprv used to be hardcoded here as a fallback. That key controls
// every user's deposit address and is in git history: treat it as compromised.
const btcKey = resolveBtcAccount({ xprv: process.env.BTC_XPRV, xpub: process.env.BTC_XPUB });
if (btcKey.error) {
  console.error(`[Deposits] New BTC deposit addresses are DISABLED: ${btcKey.error}`);
} else {
  console.log(`[Deposits] BTC deposit addresses derive from ${btcKey.source}`);
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

// Same address for the same idx whichever key form is configured, so switching
// BTC_XPRV -> BTC_XPUB does not move anyone's deposit address.
function deriveBtcDepositAddress(idx) {
  if (!btcKey.account) throw new Error("BTC deposit key not configured");
  return deriveBtcAddress(btcKey.account, idx);
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

    // existing? (retired addresses are kept for late deposits but never reissued)
    const existing = await WalletAddress.findOne({ userId, asset, chain, retiredAt: null });
    if (existing) return res.json({ address: existing.address });

    // Never hand out an address the server cannot watch or nobody can spend.
    // Checked before taking an index so a refusal doesn't burn one.
    if (chain === "btc" && !btcKey.account) {
      return res.status(503).json({ error: "BTC deposits are temporarily unavailable" });
    }

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

      // Check if wallet already exists (retired ones are never reissued)
      let existing = await WalletAddress.findOne({ userId, asset, chain, retiredAt: null });
      if (existing) {
        results[asset] = existing.address;
        continue;
      }

      // BTC issuance disabled (see btcKey): still return the other assets.
      if (chain === "btc" && !btcKey.account) {
        results[asset] = null;
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
