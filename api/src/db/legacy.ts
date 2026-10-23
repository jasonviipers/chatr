import { eq } from 'drizzle-orm';
import Database from 'better-sqlite3';
import { LEGACY_MD5_PREFIX } from '../auth/auth.ts';
import { sanitizePrivacyHtml } from '../lib/sanitize.ts';
import type { Db } from './client.ts';
import { account, privacy, user } from './schema.ts';

interface LegacyAdmin {
  username: string;
  password: string;
  createdAt: string | number;
  updatedAt: string | number;
}
interface LegacyHost extends LegacyAdmin {
  name: string;
  lastMeetingAt: string | number | null;
}
interface LegacyPrivacy {
  body: string;
}

export interface LegacyMigrationReport {
  admins: number;
  hosts: number;
  privacy: boolean;
  skipped: { username: string; reason: string }[];
}

/** Sequelize stored dates like `2022-03-01 10:00:00.000 +00:00`; make that ISO. */
function toDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return new Date(value);
  const parsed = new Date(
    value.replace(' ', 'T').replace(/ ([+-]\d\d:\d\d)$/, '$1'),
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function tableExists(legacy: Database.Database, name: string): boolean {
  return (
    legacy
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

/**
 * Imports the data of the previous API (Sequelize tables Admins, Hosts, Privacies) in one transaction.
 *
 * Passwords were plain md5 hashes. They are stored as `md5$<hex>` and Better Auth verifies them in
 * constant time and replaces them with a scrypt hash the first time that user signs in, so nobody has
 * to reset anything. Existing sessions/tokens are not carried over (everyone signs in once).
 */
export function migrateLegacyDatabase(
  db: Db,
  legacyPath: string,
): LegacyMigrationReport {
  const legacy = new Database(legacyPath, {
    readonly: true,
    fileMustExist: true,
  });
  const report: LegacyMigrationReport = {
    admins: 0,
    hosts: 0,
    privacy: false,
    skipped: [],
  };

  try {
    const admins = tableExists(legacy, 'Admins')
      ? (legacy
          .prepare(
            'SELECT username, password, createdAt, updatedAt FROM Admins ORDER BY id',
          )
          .all() as LegacyAdmin[])
      : [];
    const hosts = tableExists(legacy, 'Hosts')
      ? (legacy
          .prepare(
            'SELECT name, username, password, lastMeetingAt, createdAt, updatedAt FROM Hosts ORDER BY id',
          )
          .all() as LegacyHost[])
      : [];
    const policy = tableExists(legacy, 'Privacies')
      ? (legacy
          .prepare('SELECT body FROM Privacies ORDER BY id LIMIT 1')
          .get() as LegacyPrivacy | undefined)
      : undefined;

    db.transaction((tx) => {
      const insert = (
        row: LegacyAdmin & {
          name?: string;
          lastMeetingAt?: string | number | null;
        },
        role: 'admin' | 'host',
      ): boolean => {
        const handle = row.username.trim().toLowerCase();
        if (!/^[a-z0-9]{1,64}$/.test(handle)) {
          report.skipped.push({
            username: row.username,
            reason: 'username has characters that are not allowed any more',
          });
          return false;
        }
        if (
          tx
            .select({ id: user.id })
            .from(user)
            .where(eq(user.username, handle))
            .get()
        ) {
          report.skipped.push({
            username: row.username,
            reason:
              'username already exists (usernames are case-insensitive now)',
          });
          return false;
        }
        const createdAt = toDate(row.createdAt) ?? new Date();
        const inserted = tx
          .insert(user)
          .values({
            name: row.name ?? row.username,
            email: `${handle}@chatr.invalid`,
            emailVerified: true,
            username: handle,
            displayUsername: row.username.trim(),
            role,
            lastMeetingAt: toDate(row.lastMeetingAt),
            createdAt,
            updatedAt: toDate(row.updatedAt) ?? createdAt,
          })
          .returning({ id: user.id })
          .get();
        tx.insert(account)
          .values({
            accountId: String(inserted.id),
            providerId: 'credential',
            userId: inserted.id,
            password: LEGACY_MD5_PREFIX + row.password,
          })
          .run();
        return true;
      };

      for (const admin of admins) if (insert(admin, 'admin')) report.admins++;
      for (const host of hosts) if (insert(host, 'host')) report.hosts++;

      if (
        policy?.body &&
        !tx.select({ id: privacy.id }).from(privacy).limit(1).get()
      ) {
        tx.insert(privacy)
          .values({ body: sanitizePrivacyHtml(policy.body) })
          .run();
        report.privacy = true;
      }
    });
  } finally {
    legacy.close();
  }

  return report;
}
