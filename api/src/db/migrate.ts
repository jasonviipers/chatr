import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { loadEnv } from '../config/env.ts';
import type { Db } from './client.ts';
import { createDb } from './client.ts';

// <api>/drizzle, resolved the same way from src/db and from build/db
const MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
);

/** Applies pending migrations. Idempotent and takes a few milliseconds when up to date. */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

// `bun run db:migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const env = loadEnv();
  const { db, sqlite } = createDb(env.DATABASE_PATH);
  const started = performance.now();
  runMigrations(db);
  sqlite.close();
  console.log(
    `migrations applied to ${env.DATABASE_PATH} in ${(performance.now() - started).toFixed(1)} ms`,
  );
}
