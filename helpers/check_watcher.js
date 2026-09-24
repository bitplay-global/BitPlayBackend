import { getWatchedAddressesCount, getWatchedAddresses } from "../webhooks/btcWatcher.js";

console.log("Number of addresses being watched:", getWatchedAddressesCount());
console.log("Watched addresses:", getWatchedAddresses());