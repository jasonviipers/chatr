import { readFileSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { serve } from '@hono/node-server';
import { lt } from 'drizzle-orm';
import { createApp } from './app.ts';
import { createAuth } from './auth/auth.ts';
import { loadEnv } from './config/env.ts';
import { decideTls } from './config/tls.ts';
import { createDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { session } from './db/schema.ts';
import { createGateway } from './realtime/gateway.ts';

const env = loadEnv();
const log = (line: string) =>
  console.log(`${new Date().toISOString()} ${line}`);

const { db, sqlite } = createDb(env.DATABASE_PATH);
runMigrations(db);

const { useTls, note } = decideTls(env);
log(note);
if (!process.env['AUTH_SECRET'])
  log(
    'AUTH_SECRET is not set: using a random secret, so sessions end whenever the server restarts',
  );

const auth = createAuth({
  db,
  env,
  secureCookies: useTls || env.NODE_ENV === 'production',
});

const gateway = createGateway({
  allowedOrigins: env.allowedOrigins,
  trustProxy: env.TRUST_PROXY,
  maxConnections: env.MAX_CONNECTIONS,
  maxConnectionsPerIp: env.MAX_CONNECTIONS_PER_IP,
  log,
});

const app = createApp({
  env,
  db,
  auth,
  stats: () => gateway.stats(),
  newPeerId: () => gateway.peers.generateId(),
  log,
});

const server = serve(
  {
    fetch: app.fetch,
    port: env.PORT,
    hostname: env.HOST,
    ...(useTls
      ? {
          createServer: createHttpsServer,
          serverOptions: {
            key: readFileSync(env.TLS_KEY_PATH),
            cert: readFileSync(env.TLS_CERT_PATH),
          },
        }
      : {}),
  },
  (info) =>
    log(
      `chatr api listening on ${useTls ? 'https' : 'http'}://${info.address}:${info.port} (${env.NODE_ENV})`,
    ),
);

(server as HttpServer).on('upgrade', (request, socket, head) =>
  gateway.handleUpgrade(request, socket, head),
);
// Reverse proxies (nginx) keep connections open ~60s; stay above that so they never reuse a closed socket
if ('keepAliveTimeout' in server) {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;
}

// Expired sessions are dead weight; clean them out hourly
const sessionCleanup = setInterval(() => {
  const removed = db
    .delete(session)
    .where(lt(session.expiresAt, new Date()))
    .run().changes;
  if (removed > 0) log(`removed ${removed} expired sessions`);
}, 60 * 60_000);
sessionCleanup.unref();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, shutting down`);
  clearInterval(sessionCleanup);
  await gateway.close();
  app.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sqlite.close(); // checkpoints the WAL
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) =>
  log(
    `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
  ),
);
