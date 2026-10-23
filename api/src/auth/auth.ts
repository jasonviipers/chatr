import { createHash, timingSafeEqual } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { bearer } from 'better-auth/plugins/bearer';
import { username } from 'better-auth/plugins/username';
import type { Env } from '../config/env.ts';
import type { Db } from '../db/client.ts';
import * as schema from '../db/schema.ts';

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 25;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const USERNAME_PATTERN = /^[A-Za-z0-9]+$/;

/** Header the web server sets from the socket address so Better Auth rate-limits real client IPs. */
export const CLIENT_IP_HEADER = 'x-chatr-client-ip';

/** Hashes imported from the previous API are stored as `md5$<hex>` and upgraded to scrypt on first login. */
export const LEGACY_MD5_PREFIX = 'md5$';

export function legacyMd5Hash(password: string): string {
  return LEGACY_MD5_PREFIX + createHash('md5').update(password).digest('hex');
}

function legacyMd5Matches(stored: string, password: string): boolean {
  const expected = Buffer.from(stored.slice(LEGACY_MD5_PREFIX.length), 'hex');
  const actual = createHash('md5').update(password).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createAuth(options: {
  db: Db;
  env: Env;
  secureCookies: boolean;
}) {
  const { db, env, secureCookies } = options;

  return betterAuth({
    appName: 'Chatr',
    baseURL:
      env.BASE_URL ??
      `${secureCookies ? 'https' : 'http'}://localhost:${env.PORT}`,
    basePath: '/api/auth',
    secret: env.authSecret,
    trustedOrigins: [...env.allowedOrigins],
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),

    emailAndPassword: {
      enabled: true,
      // Accounts are created by the install flow (first admin) or by an admin (hosts) only
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) =>
          hash.startsWith(LEGACY_MD5_PREFIX)
            ? Promise.resolve(legacyMd5Matches(hash, password))
            : verifyPassword({ hash, password }),
      },
    },

    user: {
      additionalFields: {
        role: {
          type: 'string',
          required: false,
          defaultValue: 'host',
          input: false,
        },
        lastMeetingAt: { type: 'date', required: false, input: false },
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },

    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
      customRules: { '/sign-in/username': { window: 60, max: 10 } },
    },

    advanced: {
      database: { generateId: 'serial' },
      useSecureCookies: secureCookies,
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },

    plugins: [
      username({
        minUsernameLength: USERNAME_MIN,
        maxUsernameLength: USERNAME_MAX,
        usernameValidator: (value) => USERNAME_PATTERN.test(value),
      }),
      // Native/desktop apps keep the session token in storage and send `Authorization: Bearer <token>`
      bearer(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
