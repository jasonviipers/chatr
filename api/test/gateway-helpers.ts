import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createGateway, rawToString } from '../src/realtime/gateway.ts';
import type { GatewayOptions } from '../src/realtime/gateway.ts';

export const ORIGIN = 'https://app.example.test';
const cleanups: (() => Promise<void> | void)[] = [];

/** Call from afterEach: closes every gateway and socket a test opened. */
export async function cleanupAll() {
  while (cleanups.length > 0) await cleanups.pop()?.();
}

export async function startGateway(overrides: Partial<GatewayOptions> = {}) {
  const gateway = createGateway({
    allowedOrigins: new Set([ORIGIN]),
    trustProxy: false,
    maxConnections: 100,
    maxConnectionsPerIp: 50,
    ...overrides,
  });
  const server = createServer();
  server.on('upgrade', (request, socket, head) =>
    gateway.handleUpgrade(request, socket, head),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(async () => {
    await gateway.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { gateway, port };
}

export interface Client {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  send(value: object): void;
  next(
    match: (message: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  /** Waits a moment and says whether a matching message showed up (for "nothing must arrive"). */
  sawWithin(
    match: (message: Record<string, unknown>) => boolean,
    ms?: number,
  ): Promise<boolean>;
}

export async function connect(port: number, path: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    origin: ORIGIN,
  });
  const messages: Record<string, unknown>[] = [];
  const waiters: {
    match: (m: Record<string, unknown>) => boolean;
    resolve: (m: Record<string, unknown>) => void;
  }[] = [];

  ws.on('message', (data) => {
    const message = JSON.parse(rawToString(data)) as Record<string, unknown>;
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  cleanups.push(() => ws.terminate());

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  return {
    ws,
    messages,
    send: (value) => ws.send(JSON.stringify(value)),
    next: (match, timeoutMs = 2000) => {
      const already = messages.find(match);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out; got ${JSON.stringify(messages)}`)),
          timeoutMs,
        );
        waiters.push({
          match,
          resolve: (m) => (clearTimeout(timer), resolve(m)),
        });
      });
    },
    sawWithin: async (match, ms = 300) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return messages.some(match);
    },
  };
}

/** A person as the gateway knows them: a signalling socket (which owns the peer id) and an identified app socket. */
export async function person(port: number, peerId: string) {
  const token = `${peerId}-token-1`;
  const peer = await connect(
    port,
    `/peer/peerjs?key=peerjs&id=${peerId}&token=${token}`,
  );
  await peer.next((m) => m['type'] === 'OPEN');
  const socket = await connect(port, '/socket');
  socket.send({ t: 'hi', sid: `${peerId}-socket`, peerId, token });
  await socket.next((m) => m['t'] === 'hi');

  /** subscribes and says how it went: "ok" or the error code */
  const subscribe = async (channel: string) => {
    const seen = socket.messages.length;
    socket.send({ t: 'sub', c: channel });
    const answer = await socket.next(
      (m) =>
        (m['t'] === 'ok' || m['t'] === 'err') &&
        m['c'] === channel &&
        socket.messages.indexOf(m) >= seen,
    );
    return answer['t'] === 'ok' ? 'ok' : String(answer['code']);
  };

  /** publishes and says how it went: "ok" or the error code */
  let counter = 0;
  const publish = async (channel: string, data: unknown) => {
    const i = ++counter;
    socket.send({ t: 'pub', c: channel, i, d: data });
    const answer = await socket.next(
      (m) => (m['t'] === 'a' || m['t'] === 'err') && m['i'] === i,
    );
    return answer['t'] === 'a' ? 'ok' : String(answer['code']);
  };
  return { peerId, token, peer, socket, subscribe, publish };
}
