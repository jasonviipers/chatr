import { createMiddleware } from 'hono/factory';
import type { AccountService, Role } from '../auth/service.ts';
import type { AppEnv } from '../lib/http.ts';
import { fail } from '../lib/http.ts';

/**
 * Requires a valid session (Authorization: Bearer <token>) belonging to the given role.
 * Missing/expired session -> 401, signed in as the wrong kind of user -> 403.
 */
export function requireRole(accounts: AccountService, role: Role) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = await accounts.authenticate(c.req.raw.headers);
    if (!user) fail(401, 'Please sign in');
    if (user.role !== role) fail(403, 'You are not allowed to do that');
    c.set('user', user);
    await next();
  });
}
