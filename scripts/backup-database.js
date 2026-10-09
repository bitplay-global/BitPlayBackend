#!/usr/bin/env node
/**
 * Full, read-only export of the MongoDB database (MONGODB_URI) to a folder.
 *
 * For every collection it writes `<collection>.jsonl.gz`: one document per
 * line in canonical MongoDB Extended JSON, so ObjectId, Decimal128, Date and
 * Long values round-trip exactly. After `gunzip`, each file can be restored
 * with `mongoimport --uri <uri> --collection <name> --file <name>.jsonl`.
 * A `manifest.json` records the database name, time, each collection's
 * document count and its indexes (recreate those before or after import).
 *
 * Changes nothing in the database. Prints only collection names and counts.
 *
 *   node scripts/backup-database.js --out /home/pi/backups/bitplay-2026-10-09/database
 */
import '../config/loadEnv.js';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import mongoose from 'mongoose';

const { EJSON } = mongoose.mongo.BSON;

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = outIdx !== -1 ? argv[outIdx + 1] : null;
if (!OUT) { console.error('Give --out <folder>'); process.exit(2); }
if (fs.existsSync(OUT) && fs.readdirSync(OUT).length) { console.error(`${OUT} is not empty; refusing to overwrite`); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });

const started = Date.now();
await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const collections = (await db.listCollections({}, { nameOnly: false }).toArray())
  .filter(c => c.type === 'collection' && !c.name.startsWith('system.'))
  .map(c => c.name)
  .sort();

const manifest = { database: db.databaseName, startedAt: new Date(started).toISOString(), format: 'canonical Extended JSON, one document per line, gzip', collections: {} };
let total = 0;
console.log(`database ${db.databaseName}: ${collections.length} collections`);

// Collection names are case-sensitive, Windows and macOS filenames are not:
// "WebUsers" and "webusers" would overwrite each other when the backup is
// unpacked there. Names that clash ignoring case get a numbered suffix; the
// manifest maps every collection to its file.
const byLower = new Map();
for (const name of collections) byLower.set(name.toLowerCase(), [...(byLower.get(name.toLowerCase()) || []), name]);
const fileFor = name => {
  const group = byLower.get(name.toLowerCase());
  return group.length > 1 ? `${name}~${group.indexOf(name) + 1}.jsonl.gz` : `${name}.jsonl.gz`;
};

for (const name of collections) {
  const coll = db.collection(name);
  const file = fileFor(name);
  let written = 0;
  async function* lines() {
    for await (const doc of coll.find({}, { batchSize: 1000 })) {
      written++;
      yield EJSON.stringify(doc, { relaxed: false }) + '\n';
    }
  }
  await pipeline(Readable.from(lines()), zlib.createGzip(), fs.createWriteStream(path.join(OUT, file), { mode: 0o600 }));
  const countAfter = await coll.countDocuments();
  manifest.collections[name] = { file, documents: written, countAtEnd: countAfter, indexes: await coll.indexes() };
  total += written;
  console.log(`  ${name.padEnd(36)} ${String(written).padStart(9)}${countAfter !== written ? `   (count changed to ${countAfter} during export)` : ''}`);
}

manifest.finishedAt = new Date().toISOString();
manifest.totalDocuments = total;
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
await mongoose.disconnect();
console.log(`exported ${total} documents in ${((Date.now() - started) / 1000).toFixed(1)}s to ${OUT}`);
