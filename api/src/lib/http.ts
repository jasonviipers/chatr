import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthenticatedUser } from '../auth/service.ts';

/** Context variables set by the auth middleware. */
export interface AppEnv {
  Variables: { user: AuthenticatedUser };
}

/** Throws a JSON `{ message }` error with the given status. */
export function fail(
  status: ContentfulStatusCode,
  message: string,
  headers?: Record<string, string>,
): never {
  throw new HTTPException(status, {
    message,
    res: Response.json(
      { message },
      { status, ...(headers ? { headers } : {}) },
    ),
  });
}

/**
 * The address the trusted reverse proxy saw: the LAST X-Forwarded-For entry. A proxy appends the
 * address of whoever connected to it, so everything before that is client-supplied and spoofable
 * (taking the first entry would let anyone pick their own "IP" and dodge every per-IP limit).
 */
export function forwardedFor(
  header: string | string[] | undefined,
): string | undefined {
  const value = Array.isArray(header) ? header.join(',') : header;
  const last = value?.split(',').at(-1)?.trim();
  return last || undefined;
}

/**
 * The caller's address. X-Forwarded-For is only honoured when explicitly enabled (and only when a
 * reverse proxy you control sits in front), because anyone can send that header.
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = forwardedFor(c.req.header('x-forwarded-for'));
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown'; // not served over a real socket (e.g. app.request() in tests)
  }
}
