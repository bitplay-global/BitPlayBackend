import * as bip32 from "bip32";
import * as bitcoin from "bitcoinjs-lib";
import * as ecc from "tiny-secp256k1";
bitcoin.initEccLib(ecc);

const NETWORK = bitcoin.networks.bitcoin; // mainnet

export function deriveBtcAddressFromXpub(xpub, idx) {
  const node = bip32.fromBase58(xpub, NETWORK).derive(0).derive(idx); // m/.../0/idx (receiving)
  const { address } = bitcoin.payments.p2wpkh({ pubkey: node.publicKey, network: NETWORK }); // bech32
  return { address, pubkeyHex: node.publicKey.toString("hex") };
}
