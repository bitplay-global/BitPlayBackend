import { HDNodeWallet, Wallet, ethers } from "ethers";

// derive a new EVM address for a user (store only idx+address; keep mnemonic safe)
export function deriveEvmAddress(idx) {
  const root = HDNodeWallet.fromPhrase(process.env.EVM_MNEMONIC);
  const child = root.derivePath(`m/44'/60'/0'/0/${idx}`);
  return { address: child.address, privateKey: child.privateKey }; // don't log!
}
