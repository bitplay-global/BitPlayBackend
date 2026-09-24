import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ethers } from 'ethers';
import * as bitcoin from 'bitcoinjs-lib';
import BIP32Factory from 'bip32';
import * as ecc from 'tiny-secp256k1';

const bip32 = BIP32Factory(ecc);
// Throwaway keys generated for this test only.
const root = bip32.fromSeed(crypto.randomBytes(32), bitcoin.networks.bitcoin);
const XPRV = root.toBase58();
const ACCOUNT_XPUB = root.derivePath("84'/0'/0'").neutered().toBase58();
const PHRASE = ethers.Mnemonic.fromEntropy(ethers.randomBytes(16)).phrase;
const EVM_XPUB = ethers.HDNodeWallet.fromPhrase(PHRASE).derivePath("44'/60'/0'").neuter().extendedKey;

// What the deployed code derived.
const oldBtc = i => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(root.derivePath(`84'/0'/0'/0/${i}`).publicKey), network: bitcoin.networks.bitcoin }).address;
const oldEvm = i => ethers.HDNodeWallet.fromPhrase(PHRASE).derivePath(`44'/60'/0'/0/${i}`).address;

const mongod = await MongoMemoryServer.create();
await mongoose.connect(mongod.getUri(), { dbName: 'deptest' });
const WalletAddress = (await import("../models/WalletAddress.js")).default;
const DerivationCounter = (await import("../models/DerivationCounter.js")).default;
// Watchers call out to Alchemy / bitcoind; neutralise them for the test.


let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));

async function run(label, env) {
  for (const k of ['BTC_XPRV', 'BTC_XPUB', 'EVM_MNEMONIC', 'EVM_XPUB', 'EVM_PRIVATE_KEY']) delete process.env[k];
  Object.assign(process.env, env);
  await WalletAddress.deleteMany({}); await DerivationCounter.deleteMany({});
  const { default: router } = await import(`../routes/api_routes/alchemy_deposit.js?${label}`);
  const app = express(); app.use('/api/deposit-address', router);
  const server = await new Promise(res => { const srv = app.listen(0, '127.0.0.1', () => res(srv)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\n--- ${label} ---`);
  const got = { btc: [], evm: [] };
  for (let i = 0; i < 3; i++) {
    const uid = new mongoose.Types.ObjectId().toString();
    const b = await request(base).get(`/api/deposit-address/${uid}/BTC`);
    const e = await request(base).get(`/api/deposit-address/${uid}/USDT`);
    got.btc.push(b.body); got.evm.push(e.body);
  }
  const allResponses = [...got.btc, ...got.evm];
  check('responses contain only an address', allResponses.every(r => r && r.address && Object.keys(r).length === 1), JSON.stringify(allResponses[0]));
  check('BTC addresses identical to the deployed derivation', got.btc.every((r, i) => r.address === oldBtc(i)), `${got.btc[0]?.address} vs ${oldBtc(0)}`);
  check('BSC addresses identical to the deployed derivation', got.evm.every((r, i) => r.address === oldEvm(i)), `${got.evm[0]?.address} vs ${oldEvm(0)}`);
  const stored = await WalletAddress.find({}).lean();
  check('no private key stored in the database', stored.length === 6 && stored.every(d => !d.privateKey), `stored ${stored.length}, with key ${stored.filter(d => d.privateKey).length}`);
  server.close();
}

const logs = []; const origLog = console.log; const origErr = console.error;
const capture = (...a) => { const line = a.join(' '); logs.push(line); };
console.log = (...a) => { capture(...a); origLog(...a); }; console.error = (...a) => { capture(...a); origErr(...a); };

await run('private keys from env (current deployment)', { BTC_XPRV: XPRV, EVM_MNEMONIC: PHRASE });
await run('public keys only (recommended)', { BTC_XPUB: ACCOUNT_XPUB, EVM_XPUB });

console.log = origLog; console.error = origErr;
const secrets = [XPRV, PHRASE, ...Array.from({ length: 3 }, (_, i) => root.derivePath(`84'/0'/0'/0/${i}`).toWIF())];
check('no key material written to the log', !logs.some(l => secrets.some(sec => l.includes(sec))), 'a secret appeared in logs');

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
await mongoose.disconnect(); await mongod.stop(); process.exit(fail ? 1 : 0);
