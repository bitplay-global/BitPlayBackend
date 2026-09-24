#!/usr/bin/env node
/**
 * Refuses to let money-moving code reach users without an admin in the loop.
 *
 * Written after a live incident: POST /withdrawals/create-speed-payment -- the
 * endpoint the mobile app actually calls -- sent the Speed payout itself the
 * moment a user submitted a request. The approval queue existed and worked, but
 * nothing ever reached it, so every withdrawal paid out instantly and unreviewed.
 *
 * The checks below are deliberately blunt and static. They cannot prove a payout
 * is authorised, but they catch the shape of that bug: a payout call sitting in a
 * route that a user can reach.
 *
 * Run: node scripts/check-payout-guards.js   (also runs on git push)
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Outbound calls that move real money. Add to this list, never remove. */
const PAYOUT_CALLS = [
  'tryspeed.com/send',
  'tryspeed.com/payments',
];

/** The only middleware that establishes an admin is making the request. */
const ADMIN_GUARD = 'requireAdminAuth';

const failures = [];
const checked = { routes: 0, files: 0, payouts: 0 };

function jsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...jsFiles(full));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Split a router file into one block per route, each with its guard list. */
function routeBlocks(source) {
  const decl = /router\.(get|post|put|patch|delete)\(\s*(["'`])(.*?)\2\s*,([\s\S]*?)(?=\n(?:router\.(?:get|post|put|patch|delete)\(|\/\*\*|module\.exports|export default))/g;
  const blocks = [];
  let m;
  while ((m = decl.exec(source)) !== null) {
    const [, method, , path, body] = m;
    // The guards are whatever sits between the path and the handler body.
    const guardSection = body.slice(0, body.search(/async\s*\(|\(\s*req\s*,/));
    blocks.push({
      method: method.toUpperCase(),
      path,
      guards: guardSection,
      body,
      line: source.slice(0, m.index).split('\n').length,
    });
  }
  return blocks;
}

for (const file of jsFiles(join(ROOT, 'routes'))) {
  const source = readFileSync(file, 'utf8');
  checked.files++;
  if (!PAYOUT_CALLS.some(call => source.includes(call))) continue;

  for (const route of routeBlocks(source)) {
    checked.routes++;
    // Ignore commented-out code: a payout that cannot run is not a payout.
    const live = route.body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(l => !l.trim().startsWith('//'))
      .join('\n');

    const call = PAYOUT_CALLS.find(c => live.includes(c));
    if (!call) continue;
    checked.payouts++;

    if (!route.guards.includes(ADMIN_GUARD)) {
      failures.push(
        `${relative(ROOT, file)}:${route.line}\n` +
        `    ${route.method} ${route.path} calls ${call} but is not behind ${ADMIN_GUARD}.\n` +
        `    A user who can reach this endpoint gets paid without approval.\n` +
        `    Payouts belong in the admin approve route; user routes create a PENDING request.`,
      );
    }
  }
}

// The queue only means anything if new requests start outside it.
const model = readFileSync(join(ROOT, 'models', 'Withdrawal.js'), 'utf8');
if (!/status:\s*\{[\s\S]*?default:\s*["']PENDING["']/.test(model)) {
  failures.push(
    'models/Withdrawal.js\n' +
    '    Withdrawal.status no longer defaults to "PENDING".\n' +
    '    New withdrawals must start in the approval queue.',
  );
}

if (failures.length > 0) {
  console.error('\n  PAYOUT GUARD CHECK FAILED\n');
  for (const f of failures) console.error(`  ${f}\n`);
  console.error('  Refusing to push. Money must not move without an admin approving it.\n');
  process.exit(1);
}

console.log(
  `  Payout guards OK -- ${checked.payouts} payout call site(s) across ` +
  `${checked.routes} route(s) in ${checked.files} file(s), all admin-guarded; ` +
  'withdrawals default to PENDING.',
);
