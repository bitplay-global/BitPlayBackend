/**
 * Country signals on the withdrawal review page (helpers/userCountry.js) and
 * the page itself (views/withdraw.ejs) with them.
 * Run: node tests/user-country.test.mjs
 */
import ejs from 'ejs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assessUserCountry, countryFromTimezone, countryFromProfile, restrictedCountries } from '../helpers/userCountry.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => c ? (pass++, console.log(`  PASS  ${n}`)) : (fail++, console.log(`  FAIL  ${n}  ${d}`));

delete process.env.RESTRICTED_COUNTRIES;
console.log('\n--- time zone -> country ---');
check('Asia/Tehran is Iran', countryFromTimezone('Asia/Tehran')?.code === 'IR' && /Iran/.test(countryFromTimezone('Asia/Tehran').name));
check('Asia/Kolkata is India', countryFromTimezone('Asia/Kolkata')?.name === 'India');
check('old alias Asia/Calcutta is India', countryFromTimezone('Asia/Calcutta')?.code === 'IN');
check('Europe/Simferopol is Crimea, not Ukraine', countryFromTimezone('Europe/Simferopol')?.code === 'CRIMEA');
check('unknown / missing time zone: null', countryFromTimezone('Mars/Base') === null && countryFromTimezone(null) === null);

console.log('\n--- profile text ---');
check('"Iran" recognised', countryFromProfile('Iran')?.code === 'IR');
check('"ir" code recognised', countryFromProfile('ir')?.code === 'IR');
check('"India" recognised', countryFromProfile(' India ')?.code === 'IN');
check('unrecognised text kept as typed', countryFromProfile('Narnia')?.code === null && countryFromProfile('Narnia').name === 'Narnia');
check('empty profile: null', countryFromProfile('') === null);

console.log('\n--- restricted ---');
check('default list', [...restrictedCountries()].join() === 'IR,KP,CU,SY,CRIMEA');
let a = assessUserCountry({ timezone: 'Asia/Tehran' });
check('Tehran time zone: restricted', a.restricted && /Asia\/Tehran/.test(a.restrictedBy[0]), JSON.stringify(a));
a = assessUserCountry({ timezone: 'Asia/Kolkata', profileCountry: 'Iran' });
check('Iran in the profile only: restricted', a.restricted && /profile/.test(a.restrictedBy[0]));
a = assessUserCountry({ timezone: 'Asia/Kolkata' });
check('India: not restricted', !a.restricted && a.tzCountry.name === 'India');
check('no data: not restricted, nothing shown', !assessUserCountry({}).restricted && assessUserCountry({}).tzCountry === null);
process.env.RESTRICTED_COUNTRIES = 'in';
check('list from .env (case-insensitive)', assessUserCountry({ timezone: 'Asia/Kolkata' }, restrictedCountries()).restricted);
delete process.env.RESTRICTED_COUNTRIES;

console.log('\n--- the page ---');
const view = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'views', 'withdraw.ejs');
const row = (id, tz, profile) => ({
  _id: id, userId: 'u' + id, userName: 'N', userEmail: 'e@x', asset: 'USDT', chain: 'BTC', toAddress: 'name@speed.app',
  displayAmount: '1.000', displayBtc: '0.0000100000000000', userBalanceBtc: '0.0000200000000000', status: 'PENDING',
  risk: { unexplained: null, sharedAddress: null }, invoiceExpiresAt: null, created_at: new Date(),
  country: assessUserCountry({ timezone: tz, profileCountry: profile }),
});
let html = '';
try {
  html = await ejs.renderFile(view, {
    title: 'Withdrawals', user: { name: 'admin' }, page: 1, limit: 20, total: 3, search: '',
    withdrawals: [row('a1', 'Asia/Tehran'), row('a2', 'Asia/Kolkata'), row('a3', null, 'Narnia')],
  }, { root: path.join(path.dirname(view)) });
} catch (e) { html = 'RENDER ERROR ' + e.message; }
check('page renders', !html.startsWith('RENDER ERROR'), html.slice(0, 300));
check('Country column present', /<th>Country<\/th>/.test(html));
const rowHtml = id => html.split(`data-id="${id}"`)[1]?.split('</tr>')[0] || '';
check('Iran row: country and RESTRICTED badge', /Iran/.test(rowHtml('a1')) && /RESTRICTED COUNTRY/.test(rowHtml('a1')));
check('Iran row: warning carried to the Approve confirmation', /data-warnings="[^"]*RESTRICTED COUNTRY/.test(html.split('data-id="a1"')[1] || ''));
check('Iran row: no "No warnings" tick', !/No warnings/.test(rowHtml('a1')));
check('India row: country, no badge', /India/.test(rowHtml('a2')) && !/RESTRICTED/.test(rowHtml('a2')));
check('no time zone: profile text shown', /Profile: Narnia/.test(rowHtml('a3')));

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
