import type { Context } from 'hono';
import { UsernameTakenError } from '../auth/service.ts';
import type { PublicUser, Role } from '../auth/service.ts';
import { clientIp, fail } from '../lib/http.ts';
import type { AppDeps } from './deps.ts';

/** Shared by both sign-in routes: per-IP throttle, per-account lockout, uniform failure. */
export async function signIn(
  deps: AppDeps,
  c: Context,
  role: Role,
  credentials: { username: string; password: string },
) {
  const ip = clientIp(c, deps.env.TRUST_PROXY);

  const throttle = deps.limits.authRequests.hit(ip);
  if (!throttle.allowed)
    fail(429, 'Too many requests. Try again later.', {
      'retry-after': String(throttle.retryAfterSeconds),
    });

  const key = `${role}:${credentials.username.toLowerCase()}|${ip}`;
  const locked = deps.limits.logins.lockedFor(key);
  if (locked > 0)
    fail(429, 'Too many failed attempts. Try again later.', {
      'retry-after': String(locked),
    });

  const result = await deps.accounts.signIn(role, credentials);
  if (!result) {
    deps.limits.logins.recordFailure(key);
    fail(401, 'Invalid credentials');
  }

  deps.limits.logins.clear(key);
  return result;
}

export function throttleAuthRequests(deps: AppDeps, c: Context): void {
  const throttle = deps.limits.authRequests.hit(
    clientIp(c, deps.env.TRUST_PROXY),
  );
  if (!throttle.allowed)
    fail(429, 'Too many requests. Try again later.', {
      'retry-after': String(throttle.retryAfterSeconds),
    });
}

export function accountBody(user: PublicUser, token?: string) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    ...(token ? { accessToken: token } : {}),
    lastMeetingAt: user.lastMeetingAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function failIfUsernameTaken(error: unknown): never {
  if (error instanceof UsernameTakenError) fail(409, 'Username already taken');
  throw error;
}
