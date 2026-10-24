import type { Auth } from '../auth/auth.ts';
import type { AccountService } from '../auth/service.ts';
import type { Env } from '../config/env.ts';
import type { Db } from '../db/client.ts';
import type { CloudflareTurn } from '../lib/cloudflare-turn.ts';
import type { LoginGuard, SlidingWindowLimiter } from '../lib/rate-limit.ts';

export interface AppDeps {
  env: Env;
  db: Db;
  auth: Auth;
  accounts: AccountService;
  /** Live numbers shown by /health (connected sockets, ...). */
  stats: () => Record<string, number>;
  /** Unique, unguessable id for a new signalling peer. */
  newPeerId: () => string;
  /** Relay credentials from Cloudflare Realtime TURN; null when it is not configured. */
  cloudflareTurn: CloudflareTurn | null;
  limits: {
    /** Per-IP cap on sign-in / install requests. */
    authRequests: SlidingWindowLimiter;
    /** Per username+IP lockout after repeated wrong passwords. */
    logins: LoginGuard;
    /** Per-IP cap on ICE credential requests. */
    ice: SlidingWindowLimiter;
  };
}
