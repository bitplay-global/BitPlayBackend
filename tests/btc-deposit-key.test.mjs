/**
 * BTC deposit key resolution. Pure unit test, no network or database.
 * Keys are generated from fixed test seeds; none is real.
 * Run: node tests/btc-deposit-key.test.mjs
 */
import BIP32Factory from 'bip32';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { resolveBtcAccount, deriveBtcAddress, ACCOUNT_PATH } from '../helpers/btcDepositKey.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));

const bip32 = BIP32Factory(ecc);
const net = bitcoin.networks.bitcoin;
const rootA = bip32.fromSeed(Buffer.alloc(32, 1), net);
const rootB = bip32.fromSeed(Buffer.alloc(32, 2), net);
const acctA = rootA.derivePath(ACCOUNT_PATH);
const acctB = rootB.derivePath(ACCOUNT_PATH);
// Reference address straight from the full path off the root.
const refA = i => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(rootA.derivePath(`${ACCOUNT_PATH}/0/${i}`).publicKey), network: net }).address;

console.log('every valid configuration yields the same addresses');
for (const [name, env] of [
  ['root xprv only', { xprv: rootA.toBase58() }],
  ['account xprv only', { xprv: acctA.toBase58() }],
  ['account xpub only', { xpub: acctA.neutered().toBase58() }],
  ['root xprv + matching xpub', { xprv: rootA.toBase58(), xpub: acctA.neutered().toBase58() }],
  ['account xprv + matching xpub', { xprv: acctA.toBase58(), xpub: acctA.neutered().toBase58() }],
]) {
  const r = resolveBtcAccount(env);
  const ok = !r.error && [0, 1, 67, 1999].every(i => deriveBtcAddress(r.account, i).address === refA(i));
  check(name, ok, JSON.stringify({ error: r.error }));
}
{
  const r = resolveBtcAccount({ xprv: rootA.toBase58(), xpub: acctA.neutered().toBase58() });
  check('xpub preferred when both match', r.source === 'BTC_XPUB');
  check('resolved account is public-only', r.account.isNeutered());
  check('derivationPath is the full path', deriveBtcAddress(r.account, 5).derivationPath === "84'/0'/0'/0/5");
}

console.log('misconfigurations refuse instead of issuing unspendable addresses');
{
  const r = resolveBtcAccount({ xprv: rootA.toBase58(), xpub: acctB.neutered().toBase58() });
  check('xpub from a different seed is rejected', r.account === null && /different seeds/.test(r.error), r.error);
  check('nothing set is rejected', resolveBtcAccount({}).account === null);
  check('root xpub (depth 0) is rejected', /depth 0/.test(resolveBtcAccount({ xpub: rootA.neutered().toBase58() }).error || ''));
  check('private key in BTC_XPUB is rejected', /private key/.test(resolveBtcAccount({ xpub: acctA.toBase58() }).error || ''));
  check('public key in BTC_XPRV is rejected', /public key/.test(resolveBtcAccount({ xprv: acctA.neutered().toBase58() }).error || ''));
  check('wrong-depth xprv is rejected', /depth 1/.test(resolveBtcAccount({ xprv: rootA.derivePath("84'").toBase58() }).error || ''));
  check('garbage is rejected', /not a valid/.test(resolveBtcAccount({ xpub: 'xpubNOPE' }).error || ''));
  check('negative index is rejected', (() => { try { deriveBtcAddress(acctA.neutered(), -1); return false; } catch { return true; } })());
}

console.log('regression: the old route treated an account xprv as a root key');
{
  const old = i => bitcoin.payments.p2wpkh({ pubkey: Buffer.from(acctA.derivePath(`${ACCOUNT_PATH}/0/${i}`).publicKey), network: net }).address;
  const r = resolveBtcAccount({ xprv: acctA.toBase58() });
  check('account xprv no longer double-derives', deriveBtcAddress(r.account, 3).address !== old(3) && deriveBtcAddress(r.account, 3).address === refA(3));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
