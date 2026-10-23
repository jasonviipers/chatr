import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.ts';

export type Db = ReturnType<typeof createDb>['db'];

/**
 * Opens SQLite tuned for a small, write-light, read-heavy API:
 * WAL lets readers run while a write is in flight, NORMAL sync is crash-safe with WAL.
 */
export function createDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('temp_store = MEMORY');
  sqlite.pragma('cache_size = -20000'); // ~20 MB
  sqlite.pragma('mmap_size = 134217728'); // 128 MB

  const db = drizzle(sqlite, { schema });
  return { db, sqlite, schema };
}
