import * as bitcoin from "bitcoinjs-lib";
import ECPairFactory from "ecpair";
import * as ecc from "tiny-secp256k1";

const ECPair = ECPairFactory(ecc);

const wif = process.env.TEST_WIF || process.argv[2];
if (!wif) { console.error("Usage: TEST_WIF=<testnet WIF> node helpers/test-wallet.js"); process.exit(1); }
const network = bitcoin.networks.testnet;

const keyPair = ECPair.fromWIF(wif, network);

const { address } = bitcoin.payments.p2wpkh({
  pubkey: Buffer.from(keyPair.publicKey),
  network,
});

console.log("Derived testnet address:", address);
