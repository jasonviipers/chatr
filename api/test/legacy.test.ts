import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyDatabase } from '../src/db/legacy.ts';
import { call, createTestApp } from './helpers.ts';

const md5 = (value: string) => createHash('md5').update(value).digest('hex');
const folders: string[] = [];
afterEach(() => {
  while (folders.length > 0)
    rmSync(folders.pop()!, { recursive: true, force: true });
});

/** Builds a database shaped like the one the Sequelize API produced. */
function legacyDatabase(): string {
  const folder = mkdtempSync(join(tmpdir(), 'chatr-legacy-'));
  folders.push(folder);
  const path = join(folder, 'database.sqlite');
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE Admins (id INTEGER PRIMARY KEY AUTOINCREMENT, username VARCHAR(255) NOT NULL UNIQUE, accessToken UUIDV4 NOT NULL UNIQUE, password VARCHAR(255) NOT NULL, createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL);
    CREATE TABLE Hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255) NOT NULL, username VARCHAR(255) NOT NULL UNIQUE, accessToken UUIDV4 NOT NULL UNIQUE, password VARCHAR(255) NOT NULL, lastMeetingAt DATETIME, createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL);
    CREATE TABLE Privacies (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL, createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL);
  `);
  const stamp = '2022-03-01 10:00:00.000 +00:00';
  legacy
    .prepare(
      'INSERT INTO Admins (username, accessToken, password, createdAt, updatedAt) VALUES (?,?,?,?,?)',
    )
    .run('Boss', 'tok-admin', md5('boss-password'), stamp, stamp);
  const host = legacy.prepare(
    'INSERT INTO Hosts (name, username, accessToken, password, lastMeetingAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)',
  );
  host.run(
    'Anna Host',
    'Anna',
    'tok-1',
    md5('anna-password'),
    '2022-04-02 08:30:00.000 +00:00',
    stamp,
    stamp,
  );
  host.run(
    'Anna Again',
    'anna',
    'tok-2',
    md5('other-password'),
    null,
    stamp,
    stamp,
  ); // collides once usernames are case-insensitive
  host.run('Bad Name', 'bad-name!', 'tok-3', md5('x'), null, stamp, stamp);
  legacy
    .prepare(
      'INSERT INTO Privacies (body, createdAt, updatedAt) VALUES (?,?,?)',
    )
    .run('<p>Old policy</p><script>x()</script>', stamp, stamp);
  legacy.close();
  return path;
}

describe('legacy data migration', () => {
  it('imports admins, hosts and the policy, reports what it skipped, and keeps everyone able to sign in', async () => {
    const { app, db } = createTestApp();
    const started = performance.now();
    const report = migrateLegacyDatabase(db, legacyDatabase());
    expect(performance.now() - started).toBeLessThan(1000);

    expect(report.admins).toBe(1);
    expect(report.hosts).toBe(1);
    expect(report.privacy).toBe(true);
    expect(report.skipped.map((s) => s.username).sort()).toEqual([
      'anna',
      'bad-name!',
    ]);

    // old md5 passwords still work, and a wrong one does not
    const admin = await call(app, 'POST', '/admin/signIn', {
      json: { username: 'Boss', password: 'boss-password' },
    });
    expect(admin.status).toBe(200);
    expect(
      (
        await call(app, 'POST', '/admin/signIn', {
          json: { username: 'Boss', password: 'wrong-password' },
        })
      ).status,
    ).toBe(401);

    const adminToken = (admin.json as { accessToken: string }).accessToken;
    const hosts = (await call(app, 'GET', '/hosts', { token: adminToken }))
      .json as {
      username: string;
      name: string;
      lastMeetingAt: string | null;
    }[];
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      username: 'Anna',
      name: 'Anna Host',
      lastMeetingAt: '2022-04-02T08:30:00.000Z',
    });
    expect(
      (
        await call(app, 'POST', '/host/signIn', {
          json: { username: 'anna', password: 'anna-password' },
        })
      ).status,
    ).toBe(200);

    const policy = (
      (await call(app, 'GET', '/privacy')).json as { body: string }
    ).body;
    expect(policy).toBe('<p>Old policy</p>'); // script removed on import

    // running it again changes nothing
    const again = migrateLegacyDatabase(db, legacyDatabase());
    expect(again.admins + again.hosts).toBe(0);
  });
});
