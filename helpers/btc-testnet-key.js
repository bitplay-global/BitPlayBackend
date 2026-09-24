import * as bip39 from "bip39";
import BIP32Factory from "bip32";
import * as ecc from "tiny-secp256k1";
import * as bitcoin from "bitcoinjs-lib";

const network = bitcoin.networks.testnet;

// wrap bip32 with tiny-secp256k1
const bip32 = BIP32Factory(ecc);

async function generateTestnetKey() {
  const mnemonic = bip39.generateMnemonic();
  const seed = await bip39.mnemonicToSeed(mnemonic);

  const root = bip32.fromSeed(seed, network);

  console.log("Mnemonic:", mnemonic);
  console.log("Testnet XPUB:", root.neutered().toBase58());
  console.log("Testnet XPRV:", root.toBase58());
}

generateTestnetKey();
