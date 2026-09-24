import { ethers } from "ethers";
export const bsc = new ethers.JsonRpcProvider(process.env.ALCHEMY_BSC_RPC_URL);

// Standard ERC20 ABI (transfer + decimals)
export const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)"
];
