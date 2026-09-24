/**
 * Reports missing configuration at startup instead of at the first request.
 *
 * JWT_SECRET went missing on the server once and nothing said so: the app sends
 * a token with every /api call, appUserAuth answered 503 AUTH_UNAVAILABLE to all
 * of them, and the app looked broken everywhere (news, mining, wallet) while the
 * dashboard and unauthenticated calls kept working. The only clue was one line
 * per request, buried in the log.
 *
 * Nothing here throws: the admin dashboard must stay reachable so the operator
 * can act. The point is a loud, complete report at boot and a re-check anyone
 * can run on the server with `node scripts/check-env.js`.
 *
 * Never print a value -- only whether it is set.
 */

// Missing these breaks a whole user-facing area.
const REQUIRED = [
  ['JWT_SECRET', 'App tokens cannot be verified: every signed-in app request fails with 503 (news, mining, wallet, withdrawals). Must be the SAME value as the auth service uses.'],
  ['MONGODB_URI', 'No database connection.'],
];

// Missing these degrades one feature or weakens security, but the app runs.
const RECOMMENDED = [
  ['SESSION_SECRET', 'Admin sessions reset on every restart.'],
  ['ADMIN_USERNAME', 'Admin dashboard login is disabled.'],
  ['ADMIN_PASSWORD', 'Admin dashboard login is disabled.'],
  ['REVENUECAT_SECRET_KEY', 'Purchases and privileges cannot be verified, so all purchases are refused.'],
  ['REVENUECAT_WEBHOOK_AUTH', 'RevenueCat webhook is refused, so purchases whose in-app sync call failed are never recovered.'],
  ['NODE_ENV', "Should be 'production' on the live server (secure cookies, no dev behaviour)."],
];

export function checkEnvironment({ log = console } = {}) {
  const env = process.env;
  const missingRequired = REQUIRED.filter(([name]) => !env[name]);
  const missingRecommended = RECOMMENDED.filter(([name]) => !env[name]);

  // Deposits accept either the public or the private form, so they are checked
  // as a pair rather than by name.
  const depositProblems = [];
  if (!env.BTC_XPUB && !env.BTC_XPRV) depositProblems.push('BTC_XPUB (or BTC_XPRV): new BTC deposit addresses cannot be issued.');
  if (!env.EVM_XPUB && !env.EVM_MNEMONIC) depositProblems.push('EVM_XPUB (or EVM_MNEMONIC): new EVM deposit addresses cannot be issued.');

  if (env.NODE_ENV && env.NODE_ENV !== 'production') {
    missingRecommended.push(['NODE_ENV', `Set to '${env.NODE_ENV}'; the live server should run with 'production'.`]);
  }

  const ok = missingRequired.length === 0 && missingRecommended.length === 0 && depositProblems.length === 0;
  if (ok) {
    log.log('[Config] All required settings are present.');
    return { ok, missingRequired, missingRecommended, depositProblems };
  }

  const line = '='.repeat(72);
  log.error(`\n${line}`);
  log.error('  CONFIGURATION PROBLEMS');
  if (missingRequired.length) {
    log.error('\n  MISSING -- user-facing breakage:');
    for (const [name, why] of missingRequired) log.error(`    ${name}\n      ${why}`);
  }
  if (depositProblems.length) {
    log.error('\n  MISSING -- deposits:');
    for (const why of depositProblems) log.error(`    ${why}`);
  }
  if (missingRecommended.length) {
    log.error('\n  MISSING -- degraded:');
    for (const [name, why] of missingRecommended) log.error(`    ${name}\n      ${why}`);
  }
  log.error(`\n  Set these in the .env file next to server.js, then restart.`);
  log.error(`${line}\n`);

  return { ok, missingRequired, missingRecommended, depositProblems };
}

export const _internals = { REQUIRED, RECOMMENDED };
