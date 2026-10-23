import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createGateway, rawToString } from '../src/realtime/gateway.ts';
import type { GatewayOptions } from '../src/realtime/gateway.ts';
import { PubSub } from '../src/realtime/pubsub.ts';
import { PeerRegistry } from '../src/realtime/peers.ts';

const ORIGIN = 'https://app.example.test';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startGateway(overrides: Partial<GatewayOptions> = {}) {
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

interface Client {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  send(value: object): void;
  next(
    match: (message: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  closed: Promise<number>;
}

async function connect(
  port: number,
  path: string,
  options: { origin?: string | null } = {},
): Promise<Client> {
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}${path}`,
    origin ? { origin } : {},
  );
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
  const closed = new Promise<number>((resolve) =>
    ws.on('close', (code) => resolve(code)),
  );
  cleanups.push(() => ws.terminate());

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_request, response) =>
      reject(new Error(`HTTP ${response.statusCode}`)),
    );
  });

  return {
    ws,
    messages,
    closed,
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
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('pub/sub gateway', () => {
  it('delivers to every subscriber, the publisher included, and acknowledges publishes', async () => {
    const { port } = await startGateway();
    const a = await connect(port, '/socket');
    const b = await connect(port, '/socket');
    for (const client of [a, b]) {
      client.send({
        t: 'hi',
        sid: 'session-' + Math.random().toString(36).slice(2, 12),
      });
      client.send({ t: 'sub', c: '/raiseHand/meeting1' });
      await client.next((m) => m['t'] === 'ok');
    }

    a.send({ t: 'pub', c: '/raiseHand/meeting1', d: 'peer-a', i: 1 });
    expect((await a.next((m) => m['t'] === 'm'))['d']).toBe('peer-a');
    expect((await b.next((m) => m['t'] === 'm'))['d']).toBe('peer-a');
    expect(await a.next((m) => m['t'] === 'a')).toEqual({ t: 'a', i: 1 });
  });

  it('keeps channels separate', async () => {
    const { port } = await startGateway();
    const a = await connect(port, '/socket');
    a.send({ t: 'sub', c: '/raiseHand/meetingA' });
    await a.next((m) => m['t'] === 'ok');
    a.send({ t: 'pub', c: '/raiseHand/meetingB', d: 'x', i: 1 });
    await a.next((m) => m['t'] === 'a');
    await sleep(100);
    expect(a.messages.filter((m) => m['t'] === 'm')).toHaveLength(0);
  });

  it('de-duplicates a re-sent publish (the retry after a dropped connection) but still acknowledges it', async () => {
    const { port } = await startGateway();
    const a = await connect(port, '/socket');
    a.send({ t: 'hi', sid: 'dedupe-session-1' });
    a.send({ t: 'sub', c: '/raiseHand/dup' });
    await a.next((m) => m['t'] === 'ok');

    a.send({ t: 'pub', c: '/raiseHand/dup', d: 'once', i: 7 });
    a.send({ t: 'pub', c: '/raiseHand/dup', d: 'once', i: 7 });
    await sleep(150);
    expect(a.messages.filter((m) => m['t'] === 'm')).toHaveLength(1);
    expect(a.messages.filter((m) => m['t'] === 'a')).toHaveLength(2);
  });

  it('replays what a reconnecting client missed, and reports a gap when history was dropped', async () => {
    const pubsub = new PubSub({ historySize: 3 });
    const { port } = await startGateway({ pubsub });
    const live = await connect(port, '/socket');
    live.send({ t: 'sub', c: '/whiteboardDrawingAdd/room1' });
    await live.next((m) => m['t'] === 'ok');
    for (let n = 1; n <= 5; n++)
      live.send({ t: 'pub', c: '/whiteboardDrawingAdd/room1', d: { n }, i: n });
    await live.next((m) => m['t'] === 'm' && m['s'] === 5);

    // came back after seeing seq 4: gets only 5
    const recent = await connect(port, '/socket');
    recent.send({ t: 'sub', c: '/whiteboardDrawingAdd/room1', since: 4 });
    const ack = await recent.next((m) => m['t'] === 'ok');
    expect(ack).toMatchObject({ s: 5, r: 1, g: false });
    expect(
      recent.messages.filter((m) => m['t'] === 'm').map((m) => m['s']),
    ).toEqual([5]);

    // was away since seq 1 but only 3..5 are kept: replays them and flags the gap so the app can resync
    const stale = await connect(port, '/socket');
    stale.send({ t: 'sub', c: '/whiteboardDrawingAdd/room1', since: 1 });
    expect(await stale.next((m) => m['t'] === 'ok')).toMatchObject({
      s: 5,
      r: 3,
      g: true,
    });
  });

  it('rejects unknown channel names and malformed input without dropping the connection', async () => {
    const { port } = await startGateway();
    const a = await connect(port, '/socket');
    a.send({ t: 'sub', c: '/admin/everything' });
    expect(await a.next((m) => m['t'] === 'err')).toMatchObject({
      code: 'bad_channel',
    });
    a.ws.send('not json');
    expect(await a.next((m) => m['code'] === 'bad_json')).toBeTruthy();
    a.send({ t: 'ping', n: 3 });
    expect(await a.next((m) => m['t'] === 'pong')).toEqual({ t: 'pong', n: 3 });
  });

  it('only lets the verified host remove members and only the owner listen on a sync channel', async () => {
    const { port, gateway } = await startGateway();
    const host = await connect(
      port,
      '/peer/peerjs?key=peerjs&id=hostpeer01&token=host-token-1',
    );
    await host.next((m) => m['type'] === 'OPEN');
    expect(gateway.peers.verify('hostpeer01', 'host-token-1')).toBe(true);

    const hostSocket = await connect(port, '/socket');
    hostSocket.send({
      t: 'hi',
      sid: 'host-socket-1',
      peerId: 'hostpeer01',
      token: 'host-token-1',
    });
    expect(await hostSocket.next((m) => m['t'] === 'hi')).toMatchObject({
      ok: true,
      peer: true,
    });

    const guest = await connect(port, '/socket');
    guest.send({
      t: 'hi',
      sid: 'guest-socket-1',
      peerId: 'hostpeer01',
      token: 'forged-token',
    });
    expect(await guest.next((m) => m['t'] === 'hi')).toMatchObject({
      peer: false,
    }); // forged token proves nothing

    for (const client of [hostSocket, guest]) {
      client.send({ t: 'sub', c: '/memberRemove/hostpeer01' });
      await client.next((m) => m['t'] === 'ok');
    }

    guest.send({ t: 'pub', c: '/memberRemove/hostpeer01', d: 'someone', i: 1 });
    expect(await guest.next((m) => m['code'] === 'forbidden')).toMatchObject({
      i: 1,
    });

    hostSocket.send({
      t: 'pub',
      c: '/memberRemove/hostpeer01',
      d: 'someone',
      i: 1,
    });
    expect((await guest.next((m) => m['t'] === 'm'))['d']).toBe('someone');

    // sync channel is addressed to one participant
    guest.send({ t: 'sub', c: '/whiteboardDrawingSync/hostpeer01' });
    expect(
      await guest.next(
        (m) =>
          m['code'] === 'forbidden' &&
          m['c'] === '/whiteboardDrawingSync/hostpeer01',
      ),
    ).toBeTruthy();
    hostSocket.send({ t: 'sub', c: '/whiteboardDrawingSync/hostpeer01' });
    expect(
      await hostSocket.next(
        (m) =>
          m['t'] === 'ok' && m['c'] === '/whiteboardDrawingSync/hostpeer01',
      ),
    ).toBeTruthy();
  });
});

describe('connection policy', () => {
  it('refuses unknown origins and paths, allows origin-less native clients', async () => {
    const { port } = await startGateway();
    await expect(
      connect(port, '/socket', { origin: 'https://evil.example' }),
    ).rejects.toThrow('403');
    await expect(connect(port, '/nope')).rejects.toThrow('404');
    const native = await connect(port, '/socket', { origin: null });
    native.send({ t: 'ping', n: 1 });
    expect(await native.next((m) => m['t'] === 'pong')).toBeTruthy();
  });

  it('caps connections per IP', async () => {
    const { port } = await startGateway({ maxConnectionsPerIp: 2 });
    await connect(port, '/socket');
    await connect(port, '/socket');
    await expect(connect(port, '/socket')).rejects.toThrow('503');
  });

  it('closes a client that floods it', async () => {
    const { port } = await startGateway();
    const a = await connect(port, '/socket');
    for (let n = 0; n < 2000; n++) a.send({ t: 'ping', n });
    expect(await a.closed).toBe(1008);
  });
});

describe('PeerJS-compatible signalling', () => {
  it('registers peers, relays offers/answers with the sender id, and rejects id theft', async () => {
    const { port } = await startGateway();
    const a = await connect(
      port,
      '/peer/peerjs?key=peerjs&id=peerAAAA1&token=token-aaaa-1',
    );
    const b = await connect(
      port,
      '/peer/peerjs?key=peerjs&id=peerBBBB1&token=token-bbbb-1',
    );
    await a.next((m) => m['type'] === 'OPEN');
    await b.next((m) => m['type'] === 'OPEN');

    b.send({
      type: 'OFFER',
      dst: 'peerAAAA1',
      payload: { sdp: 'v=0', type: 'media', connectionId: 'c1' },
    });
    expect(await a.next((m) => m['type'] === 'OFFER')).toEqual({
      type: 'OFFER',
      src: 'peerBBBB1',
      dst: 'peerAAAA1',
      payload: { sdp: 'v=0', type: 'media', connectionId: 'c1' },
    });
    a.send({
      type: 'ANSWER',
      dst: 'peerBBBB1',
      payload: { sdp: 'v=0', type: 'media', connectionId: 'c1' },
    });
    expect(await b.next((m) => m['type'] === 'ANSWER')).toMatchObject({
      src: 'peerAAAA1',
    });

    // same id, different token: refused
    const thief = await connect(
      port,
      '/peer/peerjs?key=peerjs&id=peerAAAA1&token=another-token-9',
    );
    expect(await thief.next((m) => m['type'] === 'ID-TAKEN')).toBeTruthy();

    // src cannot be spoofed: the server stamps it from the registered id
    b.send({ type: 'OFFER', dst: 'peerAAAA1', src: 'peerCCCC1', payload: {} });
    const spoof = await a.next(
      (m) =>
        m['type'] === 'OFFER' &&
        (m['src'] === 'peerCCCC1' || m['src'] === 'peerBBBB1') &&
        a.messages.filter((x) => x['type'] === 'OFFER').length === 2,
    );
    expect(spoof['src']).toBe('peerBBBB1');
  });

  it('lets the same client reconnect with its token and delivers messages queued while it was away', async () => {
    const { port } = await startGateway();
    const caller = await connect(
      port,
      '/peer/peerjs?key=peerjs&id=callerAA1&token=caller-token-1',
    );
    await caller.next((m) => m['type'] === 'OPEN');

    // callee is not connected yet: the offer waits in the queue
    caller.send({ type: 'OFFER', dst: 'calleeBB1', payload: { sdp: 'x' } });
    await sleep(50);
    const callee = await connect(
      port,
      '/peer/peerjs?key=peerjs&id=calleeBB1&token=callee-token-1',
    );
    await callee.next((m) => m['type'] === 'OPEN');
    expect(await callee.next((m) => m['type'] === 'OFFER')).toMatchObject({
      src: 'callerAA1',
    });

    // connection drops and comes back with the same token: allowed
    callee.ws.terminate();
    await callee.closed;
    const back = await connect(
      port,
      '/peer/peerjs?key=peerjs&id=calleeBB1&token=callee-token-1',
    );
    expect(await back.next((m) => m['type'] === 'OPEN')).toBeTruthy();
  });

  it('tells the sender when the destination never shows up (EXPIRE becomes "meeting does not exist")', async () => {
    const peers = new PeerRegistry({ expireMs: 150 });
    const { port } = await startGateway({ peers });
    const a = await connect(
      port,
      '/peer/peerjs?key=peerjs&id=lonelyAA1&token=lonely-token-1',
    );
    await a.next((m) => m['type'] === 'OPEN');
    a.send({ type: 'OFFER', dst: 'ghostPeer1', payload: {} });
    expect(await a.next((m) => m['type'] === 'EXPIRE', 3000)).toEqual({
      type: 'EXPIRE',
      src: 'ghostPeer1',
      dst: 'lonelyAA1',
    });
  });

  it('rejects a wrong key or missing credentials', async () => {
    const { port } = await startGateway();
    const wrongKey = await connect(
      port,
      '/peer/peerjs?key=other&id=idid1234&token=tokentoken1',
    );
    expect(await wrongKey.next((m) => m['type'] === 'ERROR')).toMatchObject({
      payload: { msg: 'Invalid key provided' },
    });
    const noToken = await connect(port, '/peer/peerjs?key=peerjs&id=idid1234');
    expect(await noToken.next((m) => m['type'] === 'ERROR')).toBeTruthy();
  });
});

describe('peer registry (fake clock)', () => {
  it('drops peers that stop sending heartbeats', () => {
    let now = 0;
    const closed: string[] = [];
    const peers = new PeerRegistry({ aliveTimeoutMs: 1000, now: () => now });
    peers.register('quiet1', 'token-quiet-1', {
      send: () => undefined,
      close: (_code, reason) => void closed.push(reason ?? ''),
    });
    now = 500;
    peers.sweep();
    expect(peers.size).toBe(1);
    now = 1500;
    peers.sweep();
    expect(peers.size).toBe(0);
    expect(closed).toEqual(['heartbeat timeout']);
  });

  it('heartbeats keep a peer alive', () => {
    let now = 0;
    const peers = new PeerRegistry({ aliveTimeoutMs: 1000, now: () => now });
    peers.register('busy1', 'token-busy-1', {
      send: () => undefined,
      close: () => undefined,
    });
    for (now = 400; now <= 4000; now += 400) {
      peers.handle('busy1', { type: 'HEARTBEAT' });
      peers.sweep();
    }
    expect(peers.size).toBe(1);
  });
});

describe('renegotiation channel', () => {
  it('delivers only to the addressed peer and stamps the sender from its verified identity', async () => {
    const { port } = await startGateway();
    const a = await connect(
      port,
      '/peer/peerjs?key=peerjs&id=callerAA9&token=caller-token-9',
    );
    const b = await connect(
      port,
      '/peer/peerjs?key=peerjs&id=calleeBB9&token=callee-token-9',
    );
    await a.next((m) => m['type'] === 'OPEN');
    await b.next((m) => m['type'] === 'OPEN');

    const caller = await connect(port, '/socket');
    const callee = await connect(port, '/socket');
    caller.send({
      t: 'hi',
      sid: 'caller-socket-9',
      peerId: 'callerAA9',
      token: 'caller-token-9',
    });
    callee.send({
      t: 'hi',
      sid: 'callee-socket-9',
      peerId: 'calleeBB9',
      token: 'callee-token-9',
    });
    await caller.next((m) => m['t'] === 'hi');
    await callee.next((m) => m['t'] === 'hi');

    // only the owner of a peer id may listen on its channel
    caller.send({ t: 'sub', c: '/iceRestart/calleeBB9' });
    expect(await caller.next((m) => m['code'] === 'forbidden')).toBeTruthy();
    callee.send({ t: 'sub', c: '/iceRestart/calleeBB9' });
    await callee.next((m) => m['t'] === 'ok');

    // an unidentified client cannot send at all
    const stranger = await connect(port, '/socket');
    stranger.send({
      t: 'pub',
      c: '/iceRestart/calleeBB9',
      d: { kind: 'offer' },
      i: 1,
    });
    expect(await stranger.next((m) => m['code'] === 'forbidden')).toBeTruthy();

    // a forged "from" is replaced by the server with the verified peer id
    caller.send({
      t: 'pub',
      c: '/iceRestart/calleeBB9',
      d: { kind: 'offer', from: 'someoneElse', sdp: 'v=0' },
      i: 1,
    });
    const delivered = await callee.next((m) => m['t'] === 'm');
    expect(delivered['d']).toEqual({
      from: 'callerAA9',
      data: { kind: 'offer', from: 'someoneElse', sdp: 'v=0' },
    });
  });
});
