/**
 * Which country a user is probably in, and whether it is on the restricted
 * list -- for the dashboard's withdrawal review.
 *
 * Two signals, both shown:
 *  - the phone's time zone (userminings.timezone, set by the app for every
 *    miner), mapped to a country with the IANA zone table
 *    (helpers/data/tz-country.json, from tzdata's zone.tab);
 *  - the country the user typed into their profile (users.country; optional,
 *    free text).
 * Neither proves where someone is (a time zone can be changed, a VPN hides
 * nothing here) -- they are review signals, not geolocation.
 *
 * Restricted countries: RESTRICTED_COUNTRIES in .env, ISO codes separated by
 * commas. Default IR,KP,CU,SY (Iran, North Korea, Cuba, Syria) plus Crimea,
 * which shares Ukraine's code in the zone table, so it is matched by its own
 * time zone. This list is for review only; what is actually restricted is a
 * legal decision.
 */
import { createRequire } from 'module';

const TZ_COUNTRY = createRequire(import.meta.url)('./data/tz-country.json');
const DEFAULT_RESTRICTED = 'IR,KP,CU,SY,CRIMEA';
// Regions the zone table files under another country.
const TZ_REGION = { 'Europe/Simferopol': { code: 'CRIMEA', name: 'Crimea' } };

let regionNames = null;
function countryName(code) {
  if (code === 'CRIMEA') return 'Crimea';
  try {
    regionNames = regionNames || new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}

export function restrictedCountries() {
  return new Set(String(process.env.RESTRICTED_COUNTRIES ?? DEFAULT_RESTRICTED)
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
}

/** Country for an IANA time zone, or null. */
export function countryFromTimezone(tz) {
  if (!tz || typeof tz !== 'string') return null;
  if (TZ_REGION[tz]) return { ...TZ_REGION[tz] };
  const code = TZ_COUNTRY[tz];
  return code ? { code, name: countryName(code) } : null;
}

let nameToCode = null;
/** The profile's free-text country as a code, when it can be recognised. */
export function countryFromProfile(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  if (!nameToCode) {
    nameToCode = new Map();
    for (const code of new Set(Object.values(TZ_COUNTRY))) nameToCode.set(countryName(code).toLowerCase(), code);
    for (const [alias, code] of [['iran', 'IR'], ['persia', 'IR'], ['north korea', 'KP'], ['korea, north', 'KP'], ['syria', 'SY'], ['russia', 'RU'], ['usa', 'US'], ['united states of america', 'US'], ['uk', 'GB'], ['england', 'GB'], ['crimea', 'CRIMEA']]) nameToCode.set(alias, code);
  }
  const up = raw.toUpperCase();
  const code = /^[A-Z]{2}$/.test(up) && countryName(up) !== up ? up : nameToCode.get(raw.toLowerCase()) || null;
  return { code, name: code ? countryName(code) : raw };
}

/**
 * Everything the withdrawal table shows for one user.
 * @returns {{ timezone:string|null, tzCountry:object|null, profileCountry:object|null,
 *            restricted:boolean, restrictedBy:string[] }}
 */
export function assessUserCountry({ timezone, profileCountry } = {}, restricted = restrictedCountries()) {
  const tzCountry = countryFromTimezone(timezone);
  const prof = countryFromProfile(profileCountry);
  const restrictedBy = [];
  if (tzCountry && restricted.has(tzCountry.code)) restrictedBy.push(`time zone ${timezone} (${tzCountry.name})`);
  if (prof?.code && restricted.has(prof.code)) restrictedBy.push(`profile country "${String(profileCountry).trim()}"`);
  return { timezone: timezone || null, tzCountry, profileCountry: prof, restricted: restrictedBy.length > 0, restrictedBy };
}
