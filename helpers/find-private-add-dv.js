import * as bitcoin from "bitcoinjs-lib";
import BIP32Factory from "bip32";
import * as ecc from "tiny-secp256k1";

const bip32 = BIP32Factory(ecc);
const network = bitcoin.networks.bitcoin;

function deriveFromPath(xprv, idx, scriptType = "p2wpkh") {
  const root = bip32.fromBase58(xprv, network);
  const child = root.derive(parseInt(idx, 10)); // <<< mimic backend

  let payment;
  switch (scriptType) {
    case "p2wpkh":
      payment = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(child.publicKey), network });
      break;
    case "p2pkh":
      payment = bitcoin.payments.p2pkh({ pubkey: Buffer.from(child.publicKey), network });
      break;
    case "p2sh":
      payment = bitcoin.payments.p2sh({
        redeem: bitcoin.payments.p2wpkh({ pubkey: Buffer.from(child.publicKey), network }),
        network,
      });
      break;
    default:
      throw new Error("Unsupported script type");
  }

  return { address: payment.address, privateKey: child.toWIF() };
}

async function main() {
  const [,, xprv, targetAddr, derivationPath, scriptType] = process.argv;

  const idx = derivationPath.split("/").pop(); // take last number only
  const { address, privateKey } = deriveFromPath(xprv, idx, scriptType);

  console.log("Derived address:", address);
  console.log("Expected address:", targetAddr);
  console.log("Private key:", privateKey);

  if (address === targetAddr) {
    console.log("✅ Address match!");
  } else {
    console.log("❌ Address mismatch");
  }
}

main().catch(console.error);
