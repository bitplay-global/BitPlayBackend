/**
 * Telling a Lightning address from an invoice (helpers/withdrawalDestination.js).
 * Speed issues addresses that begin with "lnbc" (lnbc1p...@speed.app); approval
 * used to refuse those as an unreadable invoice.
 * Run: node tests/withdrawal-destination.test.mjs
 */
import {
  checkDestination, checkStoredDestinationForPayment, isInvoiceDestination, invoiceExpiry,
} from '../helpers/withdrawalDestination.js';
import { looksLikeInvoice } from '../helpers/bolt11.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));

const lnbcAddress = 'lnbc1pexampleuser1972abcd@speed.app';
const longAddress = `lnbc${'a'.repeat(55)}@speed.app`;

console.log('\n--- addresses that begin with lnbc ---');
check('not an invoice', !isInvoiceDestination(lnbcAddress));
let r = checkStoredDestinationForPayment(lnbcAddress);
check('payable at approval, as an address', r.ok && r.kind === 'address', JSON.stringify(r));
check('no invoice expiry shown', invoiceExpiry(lnbcAddress) === null);
r = checkDestination(lnbcAddress);
check('accepted at request, as an address', r.ok && r.kind === 'address' && r.value === lnbcAddress, JSON.stringify(r));
check('a long one is not taken for an invoice', looksLikeInvoice(longAddress) && checkDestination(longAddress).kind === 'address', JSON.stringify(checkDestination(longAddress)));

console.log('\n--- other addresses ---');
check('normal address payable', checkStoredDestinationForPayment('yourname@speed.app').kind === 'address');
check('zbd address payable', checkStoredDestinationForPayment('yourname@zbd.gg').kind === 'address');

console.log('\n--- real invoices are still treated as invoices ---');
const broken = `lnbc1${'q'.repeat(150)}`;
check('prefix without @ is an invoice', isInvoiceDestination(broken));
r = checkStoredDestinationForPayment(broken);
check('a broken invoice is still refused at approval', !r.ok && /can't be read/.test(r.error), JSON.stringify(r));
check('a broken invoice is still refused at request', !checkDestination(broken).ok);
check('garbage refused', !checkDestination('not an address').ok);
const glued = `${broken}@speed.app`; // the 19 Oct case
check('invoice with @speed.app glued on: still an invoice', isInvoiceDestination(glued));
check('glued invoice refused at approval', !checkStoredDestinationForPayment(glued).ok);
check('glued invoice refused at request, as an invoice', /invoice isn't valid/.test(checkDestination(glued).error || ''), JSON.stringify(checkDestination(glued)));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
