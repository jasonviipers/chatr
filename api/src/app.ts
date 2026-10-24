import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { CLIENT_IP_HEADER } from './auth/auth.ts';
import type { Auth } from './auth/auth.ts';
import { createAccountService } from './auth/service.ts';
import type { Env } from './config/env.ts';
import type { Db } from './db/client.ts';
import type { AppEnv } from './lib/http.ts';
import { CloudflareTurn } from './lib/cloudflare-turn.ts';
import { clientIp, fail } from './lib/http.ts';
import { LoginGuard, SlidingWindowLimiter } from './lib/rate-limit.ts';
import { adminRoutes } from './routes/admin.ts';
import type { AppDeps } from './routes/deps.ts';
import { hostRoutes } from './routes/host.ts';
import { iceRoutes } from './routes/ice.ts';
import { peerRoutes } from './routes/peer.ts';
import { privacyRoutes } from './routes/privacy.ts';
import { PeerRegistry } from './realtime/peers.ts';

export interface CreateAppOptions {
  env: Env;
  db: Db;
  auth: Auth;
  stats?: () => Record<string, number>;
  newPeerId?: () => string;
  /** Request log line sink; omitted in tests. */
  log?: (line: string) => void;
  /** Replaces the Cloudflare relay credentials client built from the environment (tests). */
  cloudflareTurn?: CloudflareTurn | null;
}

export function createApp(options: CreateAppOptions) {
  const { env, auth } = options;
  const accounts = createAccountService(auth, options.db);

  const deps: AppDeps = {
    env,
    db: options.db,
    auth,
    accounts,
    stats: options.stats ?? (() => ({})),
    newPeerId: options.newPeerId ?? (() => new PeerRegistry().generateId()),
    cloudflareTurn:
      options.cloudflareTurn !== undefined
        ? options.cloudflareTurn
        : env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN
          ? new CloudflareTurn({
              keyId: env.CLOUDFLARE_TURN_KEY_ID,
              apiToken: env.CLOUDFLARE_TURN_API_TOKEN,
              baseUrl: env.CLOUDFLARE_TURN_API_URL,
              ttlSeconds: env.CLOUDFLARE_TURN_TTL_SECONDS,
              ...(options.log ? { log: options.log } : {}),
            })
          : null,
    limits: {
      authRequests: new SlidingWindowLimiter(60_000, 30),
      logins: new LoginGuard(10 * 60_000, 8),
      ice: new SlidingWindowLimiter(60_000, 30),
    },
  };

  const app = new Hono<AppEnv>();

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
      // HTTPS only in production; development is plain HTTP and must not make browsers pin "localhost"
      strictTransportSecurity:
        env.NODE_ENV === 'production'
          ? 'max-age=63072000; includeSubDomains'
          : false,
      referrerPolicy: 'no-referrer',
      crossOriginResourcePolicy: 'cross-origin', // the SPA reads responses through CORS from another origin
      permissionsPolicy: {},
    }),
  );

  // Exact-match allow list (the previous config listed '*' inside an array, which never matched anything)
  app.use(
    cors({
      origin: (origin) => (env.allowedOrigins.has(origin) ? origin : null),
      credentials: true,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      exposeHeaders: ['set-auth-token', 'Retry-After'],
      maxAge: 600,
    }),
  );

  app.use(
    bodyLimit({
      maxSize: 128 * 1024,
      onError: (c) => c.json({ message: 'Request body is too large' }, 413),
    }),
  );

  if (options.log) {
    const log = options.log;
    app.use(async (c, next) => {
      const started = performance.now();
      await next();
      if (c.req.path === '/health') return;
      log(
        `${c.req.method} ${c.req.path} ${c.res.status} ${(performance.now() - started).toFixed(1)}ms`,
      );
    });
  }

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      ...deps.stats(),
    }),
  );

  // Better Auth owns sessions/password hashing. Sign-in goes through /admin/signIn and /host/signIn
  // (role checks, lockout, uniform timing), so the raw sign-in endpoints are not exposed.
  app.all('/api/auth/sign-in/*', () => fail(404, 'Not found'));
  app.on(['GET', 'POST'], '/api/auth/*', (c) => {
    const headers = new Headers(c.req.raw.headers);
    headers.set(CLIENT_IP_HEADER, clientIp(c, env.TRUST_PROXY)); // overwrite whatever the client sent
    return auth.handler(new Request(c.req.raw, { headers }));
  });

  const routes = app
    .route('/', adminRoutes(deps))
    .route('/', hostRoutes(deps))
    .route('/', privacyRoutes(deps))
    .route('/', iceRoutes(deps))
    .route('/', peerRoutes(deps));

  app.notFound((c) => c.json({ message: 'Not found' }, 404));

  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.json(
        { message: error.message || 'Request failed' },
        error.status,
        error.res?.headers.get('retry-after')
          ? { 'retry-after': error.res.headers.get('retry-after') ?? '' }
          : {},
      );
    }
    options.log?.(
      `ERROR ${c.req.method} ${c.req.path} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return c.json({ message: 'Something went wrong' }, 500);
  });

  return Object.assign(routes, {
    shutdown() {
      deps.limits.authRequests.stop();
      deps.limits.ice.stop();
    },
  });
}

/** Import this type in clients for end-to-end typed calls with hono/client. */
export type AppType = ReturnType<typeof createApp>;
