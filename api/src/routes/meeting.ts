import { Hono } from 'hono';
import type { AppEnv } from '../lib/http.ts';
import { clientIp, fail } from '../lib/http.ts';
import { PEER_ID_PATTERN } from '../realtime/peers.ts';
import type { AppDeps } from './deps.ts';

/**
 * Whether a meeting is open, so somebody who follows a link to a locked meeting is told so at once instead of
 * waiting for a call that will never be answered. It says nothing about whether the meeting exists, and
 * nothing is let in or out here: the gateway is what keeps strangers out of a locked meeting.
 */
export function meetingRoutes(deps: AppDeps) {
  return new Hono<AppEnv>().get('/meetings/:id', (c) => {
    const limited = deps.limits.meetings.hit(clientIp(c, deps.env.TRUST_PROXY));
    if (!limited.allowed)
      fail(429, 'Too many requests. Try again later.', {
        'retry-after': String(limited.retryAfterSeconds),
      });
    const id = c.req.param('id');
    if (!PEER_ID_PATTERN.test(id)) fail(400, 'Invalid meeting id');
    c.header('cache-control', 'no-store');
    return c.json({ locked: deps.meetings.isLocked(id) });
  });
}
