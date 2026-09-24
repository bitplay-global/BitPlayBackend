// helpers/evm-mnemonic.js
import { Wallet } from "ethers";

// Create a new random wallet from a mnemonic
const wallet = Wallet.createRandom();

if (wallet.mnemonic) {
  console.log("Mnemonic:", wallet.mnemonic.phrase);
  console.log("Derivation Path:", wallet.mnemonic.path);
} else {
  console.log("No mnemonic generated (this should not happen with createRandom).");
}

console.log("Address:", wallet.address);
console.log("Private Key:", wallet.privateKey);
