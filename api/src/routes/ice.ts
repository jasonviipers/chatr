import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import type { Env } from '../config/env.ts';
import type { AppEnv } from '../lib/http.ts';
import { clientIp, fail } from '../lib/http.ts';
import type { AppDeps } from './deps.ts';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * STUN servers find the public address; a TURN server relays media when two peers cannot reach each
 * other directly (symmetric NAT, corporate firewalls, mobile carriers). Relaying is what keeps a call
 * alive for people on bad networks, so TURN credentials are issued here when a TURN server is configured.
 * Credentials follow coturn's REST scheme (`use-auth-secret`): username = expiry timestamp,
 * credential = base64(HMAC-SHA1(secret, username)), so they stop working by themselves.
 */
export function buildIceServers(
  env: Pick<
    Env,
    'STUN_URLS' | 'TURN_URLS' | 'TURN_SECRET' | 'TURN_TTL_SECONDS'
  >,
  nowMs = Date.now(),
) {
  const iceServers: IceServer[] = [{ urls: env.STUN_URLS }];

  if (env.TURN_URLS.length > 0 && env.TURN_SECRET) {
    const username = String(Math.floor(nowMs / 1000) + env.TURN_TTL_SECONDS);
    const credential = createHmac('sha1', env.TURN_SECRET)
      .update(username)
      .digest('base64');
    iceServers.push({ urls: env.TURN_URLS, username, credential });
  }

  return { iceServers, ttl: env.TURN_TTL_SECONDS };
}

export function iceRoutes(deps: AppDeps) {
  return new Hono<AppEnv>().get('/ice-servers', (c) => {
    const limited = deps.limits.ice.hit(clientIp(c, deps.env.TRUST_PROXY));
    if (!limited.allowed)
      fail(429, 'Too many requests. Try again later.', {
        'retry-after': String(limited.retryAfterSeconds),
      });
    c.header('cache-control', 'no-store');
    return c.json(buildIceServers(deps.env));
  });
}
