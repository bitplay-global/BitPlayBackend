#!/usr/bin/env node
/**
 * Prints which settings the live server is missing, without connecting to
 * anything and without printing any value. Run it on the server:
 *
 *   node scripts/check-env.js
 *
 * Exits non-zero if something required is missing, so it can gate a deploy.
 */
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { checkEnvironment } from '../helpers/checkEnvironment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const { ok, missingRequired } = checkEnvironment();
process.exit(ok || missingRequired.length === 0 ? 0 : 1);
