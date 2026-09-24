// Must be the FIRST import in server.js. ES module static imports fully
// evaluate before the importing file's own top-level code runs, so any
// module imported above dotenv.config() reads process.env before .env is
// loaded -- e.g. admin.js's `const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD`
// was permanently freezing to '' regardless of what .env actually contained.
// Importing this file first, before every other local import, guarantees
// .env is loaded before anything else reads process.env.
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });
