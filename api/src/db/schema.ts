import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Intentionally free of local imports so drizzle-kit can load this file on its own.

const now = sql`(unixepoch() * 1000)`;

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(now),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(now)
    .$onUpdate(() => new Date()),
};

/** Better Auth: users. `role` is 'admin' | 'host'; hosts are created by an admin. */
export const user = sqliteTable(
  'user',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: integer('email_verified', { mode: 'boolean' })
      .notNull()
      .default(false),
    image: text('image'),
    username: text('username').unique(),
    displayUsername: text('display_username'),
    role: text('role', { enum: ['admin', 'host'] })
      .notNull()
      .default('host'),
    lastMeetingAt: integer('last_meeting_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (t) => [index('user_role_idx').on(t.role)],
);

/** Better Auth: sessions (the bearer token the apps send is derived from `token`). */
export const session = sqliteTable(
  'session',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    token: text('token').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: integer('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [
    index('session_user_idx').on(t.userId),
    index('session_expires_idx').on(t.expiresAt),
  ],
);

/** Better Auth: credential accounts (scrypt password hash lives here). */
export const account = sqliteTable(
  'account',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    scope: text('scope'),
    password: text('password'),
    ...timestamps,
  },
  (t) => [index('account_user_idx').on(t.userId)],
);

/** Better Auth: verification tokens (unused while sign-up/e-mail flows are disabled). */
export const verification = sqliteTable(
  'verification',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    ...timestamps,
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

/** The public privacy policy page (single row, HTML sanitised on write). */
export const privacy = sqliteTable('privacy', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  body: text('body').notNull(),
  ...timestamps,
});

export type User = typeof user.$inferSelect;
export type Privacy = typeof privacy.$inferSelect;
