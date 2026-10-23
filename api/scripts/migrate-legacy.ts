import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from '../src/config/env.ts';
import { createDb } from '../src/db/client.ts';
import { migrateLegacyDatabase } from '../src/db/legacy.ts';
import { runMigrations } from '../src/db/migrate.ts';

// bun run migrate:legacy [path-to-old-database.sqlite]   (default: ../database.sqlite)
const legacyPath = resolve(process.argv[2] ?? '../database.sqlite');
if (!existsSync(legacyPath)) {
  console.error(`legacy database not found: ${legacyPath}`);
  process.exit(1);
}

const env = loadEnv();
const { db, sqlite } = createDb(env.DATABASE_PATH);
runMigrations(db);

const started = performance.now();
const report = migrateLegacyDatabase(db, legacyPath);
sqlite.close();

console.log(
  `imported ${report.admins} admin(s), ${report.hosts} host(s)${report.privacy ? ' and the privacy policy' : ''} into ${env.DATABASE_PATH} in ${(performance.now() - started).toFixed(0)} ms`,
);
for (const skipped of report.skipped)
  console.warn(`skipped "${skipped.username}": ${skipped.reason}`);
console.log(
  'Users keep their passwords; they are upgraded to a stronger hash the first time each signs in.',
);
