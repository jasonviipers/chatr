import { createApp } from '../src/app.ts';
import { createAuth } from '../src/auth/auth.ts';
import { loadEnv } from '../src/config/env.ts';
import type { Env } from '../src/config/env.ts';
import { createDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';

export const ORIGIN = 'https://app.example.test';

export function createTestApp(
  overrides: Record<string, string> = {},
  appOptions: Partial<Parameters<typeof createApp>[0]> = {},
) {
  const env: Env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    AUTH_SECRET: 'test-secret-test-secret-test-secret-1234',
    WEB_APP_HOST: 'app.example.test',
    ...overrides,
  });
  const database = createDb(':memory:');
  runMigrations(database.db);
  const auth = createAuth({ db: database.db, env, secureCookies: true });
  const app = createApp({ env, db: database.db, auth, ...appOptions });
  return { app, auth, env, ...database };
}

type TestApp = ReturnType<typeof createTestApp>['app'];

export interface CallOptions {
  json?: unknown;
  raw?: string;
  token?: string;
  headers?: Record<string, string>;
}

/** Calls the app in-process (no network) and parses the JSON body when there is one. */
export async function call(
  app: TestApp,
  method: string,
  path: string,
  options: CallOptions = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers['authorization'] = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers['content-type'] = 'application/json';
  } else if (options.raw !== undefined) {
    body = options.raw;
    headers['content-type'] = 'application/json';
  }
  const response = await app.request(path, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: json as Record<string, unknown> | unknown[] | null | undefined,
  };
}

export const ADMIN = { username: 'admin1', password: 'secret-pass-1' };
export const HOST = {
  name: 'Host One',
  username: 'host1',
  password: 'host-pass-1',
};

/** Installs the first admin and returns its bearer token. */
export async function installAdmin(app: TestApp): Promise<string> {
  const created = await call(app, 'POST', '/admin', {
    json: { ...ADMIN, confirmPassword: ADMIN.password },
  });
  if (created.status !== 201)
    throw new Error(`install failed: ${created.text}`);
  const signedIn = await call(app, 'POST', '/admin/signIn', { json: ADMIN });
  return (signedIn.json as { accessToken: string }).accessToken;
}
