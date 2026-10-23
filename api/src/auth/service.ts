import { and, desc, eq } from 'drizzle-orm';
import { isAPIError } from 'better-auth/api';
import type { Db } from '../db/client.ts';
import { user } from '../db/schema.ts';
import type { User } from '../db/schema.ts';
import type { Auth } from './auth.ts';
import { LEGACY_MD5_PREFIX } from './auth.ts';

export type Role = User['role'];

/** What the API may expose about an account. Password hashes and tokens never leave this module. */
export interface PublicUser {
  id: number;
  name: string;
  username: string;
  lastMeetingAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthenticatedUser extends PublicUser {
  role: Role;
}

export function toPublicUser(row: User): PublicUser {
  return {
    id: row.id,
    name: row.name,
    username: row.displayUsername ?? row.username ?? '',
    lastMeetingAt: row.lastMeetingAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Serialises concurrent first-install requests so only one administrator can ever be created that way. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export class UsernameTakenError extends Error {
  constructor() {
    super('Username already taken');
  }
}

export function createAccountService(auth: Auth, db: Db) {
  const installLock = new Mutex();

  const normalise = (username: string) => username.trim().toLowerCase();

  async function createUserRecord(input: {
    username: string;
    name: string;
    password: string;
    role: Role;
  }): Promise<PublicUser> {
    const ctx = await auth.$context;
    const handle = normalise(input.username);

    if (
      db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.username, handle))
        .get()
    )
      throw new UsernameTakenError();

    const created = await ctx.internalAdapter.createUser(
      {
        name: input.name,
        email: `${handle}@chatr.invalid`, // Better Auth needs an e-mail; accounts here are username based
        emailVerified: true,
        username: handle,
        displayUsername: input.username.trim(),
        role: input.role,
      },
      { method: 'admin' },
    );
    await ctx.internalAdapter.linkAccount({
      userId: created.id,
      providerId: 'credential',
      accountId: String(created.id),
      password: await ctx.password.hash(input.password),
    });

    const row = db
      .select()
      .from(user)
      .where(eq(user.id, Number(created.id)))
      .get();
    if (!row) throw new Error('user vanished after creation');
    return toPublicUser(row);
  }

  return {
    findAdmin(): PublicUser | null {
      const row = db
        .select()
        .from(user)
        .where(eq(user.role, 'admin'))
        .orderBy(user.id)
        .limit(1)
        .get();
      return row ? toPublicUser(row) : null;
    },

    /** Only succeeds while no administrator exists (the install flow). */
    createFirstAdmin(input: {
      username: string;
      password: string;
    }): Promise<PublicUser | null> {
      return installLock.run(async () => {
        if (this.findAdmin()) return null;
        return createUserRecord({
          username: input.username,
          name: input.username.trim(),
          password: input.password,
          role: 'admin',
        });
      });
    },

    createHost(input: {
      name: string;
      username: string;
      password: string;
    }): Promise<PublicUser> {
      return createUserRecord({ ...input, role: 'host' });
    },

    listHosts(): PublicUser[] {
      return db
        .select()
        .from(user)
        .where(eq(user.role, 'host'))
        .orderBy(desc(user.createdAt))
        .all()
        .map(toPublicUser);
    },

    async deleteHost(id: number): Promise<boolean> {
      const row = db
        .select({ id: user.id })
        .from(user)
        .where(and(eq(user.id, id), eq(user.role, 'host')))
        .get();
      if (!row) return false;
      const ctx = await auth.$context;
      await ctx.internalAdapter.deleteUserSessions(String(id));
      await ctx.internalAdapter.deleteUser(String(id));
      return true;
    },

    touchLastMeeting(id: number): void {
      db.update(user)
        .set({ lastMeetingAt: new Date() })
        .where(eq(user.id, id))
        .run();
    },

    /**
     * Verifies the credentials for the given role and opens a session.
     * Unknown user, wrong role and wrong password are indistinguishable (same result, same work).
     */
    async signIn(
      role: Role,
      credentials: { username: string; password: string },
    ): Promise<{ token: string; user: PublicUser } | null> {
      const ctx = await auth.$context;
      const handle = normalise(credentials.username);
      const row = db.select().from(user).where(eq(user.username, handle)).get();

      if (!row || row.role !== role) {
        await ctx.password.hash(credentials.password); // keep timing uniform
        return null;
      }

      let result;
      try {
        result = await auth.api.signInUsername({
          body: { username: handle, password: credentials.password },
          returnHeaders: true,
        });
      } catch (error) {
        if (isAPIError(error)) return null;
        throw error;
      }

      const token = result.headers.get('set-auth-token');
      if (!token)
        throw new Error(
          'Better Auth did not return a bearer token (is the bearer plugin enabled?)',
        );

      // Upgrade legacy md5 hashes to scrypt now that the password is known to be right
      const account = await ctx.internalAdapter.findCredentialAccount(
        String(row.id),
      );
      if (account?.password?.startsWith(LEGACY_MD5_PREFIX)) {
        await ctx.internalAdapter.updatePassword(
          String(row.id),
          await ctx.password.hash(credentials.password),
        );
      }

      return { token, user: toPublicUser(row) };
    },

    /** Resolves `Authorization: Bearer <token>` (or a session cookie) to the account, or null. */
    async authenticate(headers: Headers): Promise<AuthenticatedUser | null> {
      const session = await auth.api.getSession({ headers });
      if (!session) return null;
      const row = db
        .select()
        .from(user)
        .where(eq(user.id, Number(session.user.id)))
        .get();
      return row ? { ...toPublicUser(row), role: row.role } : null;
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;
