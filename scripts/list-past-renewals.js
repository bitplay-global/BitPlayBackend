/**
 * Lists pack renewals that were charged before monthly renewal was honoured
 * (LEGACY_RENEWALS_FROM, 2026-10-26) and so granted nothing. Read-only: it
 * changes nothing, it is the list an admin decides on. The counts are
 * estimates; see helpers/pastRenewals.js.
 *
 *   node scripts/list-past-renewals.js [out.csv]
 */
import '../config/loadEnv.js';
import fs from 'fs';
import mongoose from 'mongoose';
import { findPastRenewals } from '../helpers/pastRenewals.js';

await mongoose.connect(process.env.MONGODB_URI);
const { rows, checked, errors, cutoff } = await findPastRenewals();

const cols = Object.keys(rows[0] || { email: '' }).filter(c => !c.startsWith('rc_'));
const csv = [cols.join(','), ...rows.map(r => cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
if (process.argv[2]) fs.writeFileSync(process.argv[2], csv + '\n');
else console.log(csv);
console.error(`\ncustomers checked ${checked}, errors ${errors}; users with unrewarded renewals ${rows.length}, ` +
  `estimated renewals ${rows.reduce((s, r) => s + r.est_unrewarded_renewals, 0)}, still auto-renewing ${rows.filter(r => r.still_renewing === 'yes').length}; cut-over ${cutoff.toISOString()}`);
await mongoose.disconnect();
