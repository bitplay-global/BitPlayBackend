#!/usr/bin/env node
/**
 * Catches a unique index that will reject rows it was meant to ignore.
 *
 * A `sparse` unique index skips documents where the field is ABSENT, but still
 * indexes an explicit null. Pair it with `default: null` and every row saved
 * without a value stores null -- so the second one fails with E11000.
 *
 * That exact bug shipped on store_transaction_id in two models and was caught
 * only later. The fix is a partial index (partialFilterExpression on a real
 * type) or no null default. This fails the commit if the combination returns.
 */
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const MODELS = join(dirname(fileURLToPath(import.meta.url)), '..', 'models');
const problems = [];

for (const file of readdirSync(MODELS).filter(f => f.endsWith('.js'))) {
  const src = readFileSync(join(MODELS, file), 'utf8');

  // Fields indexed { field: 1 } with unique + sparse.
  const sparseUnique = [...src.matchAll(/\.index\(\s*\{\s*(\w+)\s*:\s*-?1\s*\}\s*,\s*\{([^}]*)\}/g)]
    .filter(m => /unique\s*:\s*true/.test(m[2]) && /sparse\s*:\s*true/.test(m[2]))
    .map(m => m[1]);
  // Inline field options: field: { ..., unique: true, sparse: true }
  for (const m of src.matchAll(/(\w+)\s*:\s*\{([^{}]*)\}/g)) {
    if (/unique\s*:\s*true/.test(m[2]) && /sparse\s*:\s*true/.test(m[2])) sparseUnique.push(m[1]);
  }

  for (const field of new Set(sparseUnique)) {
    const def = src.match(new RegExp(`\\b${field}\\s*:\\s*\\{([^{}]*)\\}`));
    if (def && /default\s*:\s*null/.test(def[1])) {
      problems.push(`models/${file}: "${field}" has default: null under a sparse unique index -- ` +
        'explicit nulls are indexed, so the second row without a value fails with E11000. ' +
        "Use partialFilterExpression: { " + field + ": { $type: 'string' } } or drop the null default.");
    }
  }
}

if (problems.length) {
  console.error('\n  MODEL INDEX CHECK FAILED\n');
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}
console.log('  Model indexes OK -- no sparse unique index over a null default.');
