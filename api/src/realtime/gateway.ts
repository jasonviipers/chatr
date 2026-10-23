import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RawData } from 'ws';
import { WebSocket, WebSocketServer } from 'ws';
import { forwardedFor } from '../lib/http.ts';
import { TokenBucket } from '../lib/rate-limit.ts';
import { buildChatPayload } from './chat.ts';
import { buildMediaStatePayload } from './media-state.ts';
import type { Connection } from './pubsub.ts';
import { PubSub } from './pubsub.ts';
import {
  PEER_ID_PATTERN,
  PEER_KEY,
  PEER_TOKEN_PATTERN,
  PeerRegistry,
  parsePeerMessage,
} from './peers.ts';

/** Application events carried over the socket (the same ones the faye channels carried). */
const CHANNEL_KINDS = new Set([
  'raiseHand',
  'conferenceCall',
  'remoteDisconnect',
  'memberRemove',
  'rtpTrackReplaced',
  'whiteboardEnabled',
  'whiteboardDrawingSync',
  'whiteboardDrawingAdd',
  'whiteboardCanvasClear',
  'iceRestart',
  'chat',
  'mediaState',
]);
const CHANNEL_PATTERN = /^\/([A-Za-z]{1,32})\/([A-Za-z0-9_-]{1,64})$/;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const MAX_CHANNELS_PER_CONNECTION = 32;
/** A client that cannot drain its socket is cut off (it reconnects and resumes) instead of growing our memory. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const HEARTBEAT_MS = 20_000;

export interface GatewayOptions {
  allowedOrigins: ReadonlySet<string>;
  trustProxy: boolean;
  maxConnections: number;
  maxConnectionsPerIp: number;
  pubsub?: PubSub;
  peers?: PeerRegistry;
  log?: (line: string) => void;
}

export interface Gateway {
  readonly pubsub: PubSub;
  readonly peers: PeerRegistry;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  stats(): Record<string, number>;
  close(): Promise<void>;
}

/** Whether `conn` may use a channel. Host-only and owner-only rules live here. */
export function channelAllowed(
  conn: Pick<Connection, 'peerId'>,
  kind: string,
  id: string,
  action: 'subscribe' | 'publish',
): boolean {
  switch (kind) {
    // only the host (whose verified peer id *is* the meeting id) may remove people
    case 'memberRemove':
      return action === 'subscribe' || conn.peerId === id;
    // addressed to one participant: only that participant may listen, only identified peers may send
    case 'iceRestart': // renegotiation messages between two peers of a call
    case 'whiteboardDrawingSync':
      return action === 'subscribe' ? conn.peerId === id : conn.peerId !== null;
    // anyone in the meeting may read the chat, but only identified participants may write to it
    case 'chat':
    case 'mediaState': // who has the camera or the microphone on
      return action === 'subscribe' || conn.peerId !== null;
    default:
      return true;
  }
}

export function parseChannel(
  name: unknown,
): { kind: string; id: string } | null {
  if (typeof name !== 'string') return null;
  const match = CHANNEL_PATTERN.exec(name);
  if (!match) return null;
  const [, kind, id] = match;
  if (kind === undefined || id === undefined || !CHANNEL_KINDS.has(kind))
    return null;
  return { kind, id };
}

/** ws hands frames over as Buffer | ArrayBuffer | Buffer[]; this turns any of them into text. */
export function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

export function createGateway(options: GatewayOptions): Gateway {
  const pubsub = options.pubsub ?? new PubSub();
  const peers = options.peers ?? new PeerRegistry();
  const log = options.log ?? (() => undefined);

  // Messages are small JSON; compression helps on slow links, no context takeover keeps memory per socket low
  const appServer = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: {
      threshold: 1024,
      zlibDeflateOptions: { level: 1 },
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      concurrencyLimit: 8,
    },
  });
  const peerServer = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });

  const alive = new WeakMap<WebSocket, boolean>();
  const perIp = new Map<string, number>();
  let total = 0;
  let nextConnectionId = 0;

  const send = (ws: WebSocket, frame: string): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      ws.terminate();
      return;
    }
    ws.send(frame);
  };

  const ipOf = (request: IncomingMessage): string => {
    if (options.trustProxy) {
      const forwarded = forwardedFor(request.headers['x-forwarded-for']);
      if (forwarded) return forwarded;
    }
    return request.socket.remoteAddress ?? 'unknown';
  };

  const release = (ip: string): void => {
    total--;
    const left = (perIp.get(ip) ?? 1) - 1;
    if (left <= 0) perIp.delete(ip);
    else perIp.set(ip, left);
  };

  const trackLiveness = (ws: WebSocket): void => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', () => alive.set(ws, true));
  };

  function onAppConnection(ws: WebSocket, ip: string): void {
    trackLiveness(ws);
    const conn: Connection = {
      id: ++nextConnectionId,
      sid: null,
      peerId: null,
      channels: new Set(),
      send: (frame) => send(ws, frame),
    };
    const bucket = new TokenBucket(200, 100);
    // chatting is human speed: a burst of ten messages, then one a second
    const chatBucket = new TokenBucket(10, 1);
    const stateBucket = new TokenBucket(20, 4);
    let violations = 0;

    const reply = (value: object): void => send(ws, JSON.stringify(value));

    ws.on('message', (data, isBinary) => {
      if (isBinary) return void ws.close(1003, 'text frames only');
      if (!bucket.take()) {
        if (++violations > 100) ws.close(1008, 'rate limit exceeded');
        return;
      }

      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(rawToString(data));
        if (typeof parsed !== 'object' || parsed === null) return;
        message = parsed as Record<string, unknown>;
      } catch {
        return reply({ t: 'err', code: 'bad_json' });
      }

      switch (message['t']) {
        case 'hi': {
          const sid = message['sid'];
          if (typeof sid === 'string' && SESSION_PATTERN.test(sid))
            conn.sid = sid;
          const peerId = message['peerId'];
          const token = message['token'];
          if (
            typeof peerId === 'string' &&
            typeof token === 'string' &&
            peers.verify(peerId, token)
          )
            conn.peerId = peerId;
          return reply({
            t: 'hi',
            ok: conn.sid !== null,
            peer: conn.peerId !== null,
          });
        }

        case 'sub': {
          const channel = parseChannel(message['c']);
          const name = message['c'] as string;
          if (!channel)
            return reply({ t: 'err', code: 'bad_channel', c: message['c'] });
          if (!channelAllowed(conn, channel.kind, channel.id, 'subscribe'))
            return reply({ t: 'err', code: 'forbidden', c: name });
          if (
            !conn.channels.has(name) &&
            conn.channels.size >= MAX_CHANNELS_PER_CONNECTION
          )
            return reply({ t: 'err', code: 'too_many_channels', c: name });
          const since =
            typeof message['since'] === 'number' &&
            Number.isInteger(message['since']) &&
            message['since'] >= 0
              ? message['since']
              : undefined;
          const result = pubsub.subscribe(conn, name, since);
          return reply({
            t: 'ok',
            c: name,
            s: result.seq,
            r: result.replayed,
            g: result.gap,
          });
        }

        case 'unsub': {
          if (typeof message['c'] === 'string')
            pubsub.unsubscribe(conn, message['c']);
          return;
        }

        case 'pub': {
          const channel = parseChannel(message['c']);
          const name = message['c'] as string;
          const messageId =
            typeof message['i'] === 'number' &&
            Number.isSafeInteger(message['i'])
              ? message['i']
              : undefined;
          if (!channel)
            return reply({
              t: 'err',
              code: 'bad_channel',
              c: message['c'],
              ...(messageId !== undefined ? { i: messageId } : {}),
            });
          if (!channelAllowed(conn, channel.kind, channel.id, 'publish'))
            return reply({
              t: 'err',
              code: 'forbidden',
              c: name,
              ...(messageId !== undefined ? { i: messageId } : {}),
            });
          const refuse = (code: string): void =>
            reply({
              t: 'err',
              code,
              c: name,
              ...(messageId !== undefined ? { i: messageId } : {}),
            });

          // who sent a renegotiation or chat message is stamped by the server, so it cannot be forged
          let payload: unknown;
          if (channel.kind === 'iceRestart') {
            payload = { from: conn.peerId, data: message['d'] ?? null };
          } else if (channel.kind === 'chat') {
            if (!chatBucket.take()) return refuse('rate_limited');
            const chat = buildChatPayload(conn.peerId, message['d']);
            if (chat === null) return refuse('bad_message');
            payload = chat;
          } else if (channel.kind === 'mediaState') {
            if (!stateBucket.take()) return refuse('rate_limited');
            const state = buildMediaStatePayload(conn.peerId, message['d']);
            if (state === null) return refuse('bad_message');
            payload = state;
          } else {
            payload = message['d'] ?? null;
          }
          pubsub.publish(name, payload, conn.sid, messageId);
          if (messageId !== undefined) reply({ t: 'a', i: messageId });
          return;
        }

        case 'ping':
          return reply({ t: 'pong', n: message['n'] ?? null });

        default:
          return reply({ t: 'err', code: 'unknown_type' });
      }
    });

    ws.on('close', () => {
      pubsub.drop(conn);
      release(ip);
    });
    ws.on('error', (error) => log(`socket error ${error.message}`));
  }

  function onPeerConnection(
    ws: WebSocket,
    request: IncomingMessage,
    ip: string,
  ): void {
    trackLiveness(ws);
    const url = new URL(request.url ?? '/', 'http://gateway');
    const id = url.searchParams.get('id');
    const token = url.searchParams.get('token');
    const key = url.searchParams.get('key');
    const adapter = {
      send: (data: string) => send(ws, data),
      close: (code?: number, reason?: string) => ws.close(code, reason),
    };

    const reject = (type: string, msg: string): void => {
      send(ws, JSON.stringify({ type, payload: { msg } }));
      ws.close(1008, msg);
      release(ip);
    };

    if (key !== PEER_KEY) return reject('ERROR', 'Invalid key provided');
    if (!id || !PEER_ID_PATTERN.test(id))
      return reject('ERROR', 'Invalid id provided');
    if (!token || !PEER_TOKEN_PATTERN.test(token))
      return reject('ERROR', 'Invalid token provided');
    if (peers.register(id, token, adapter) === 'taken')
      return reject('ID-TAKEN', 'ID is taken');

    send(ws, JSON.stringify({ type: 'OPEN' }));

    const bucket = new TokenBucket(100, 50);
    ws.on('message', (data, isBinary) => {
      if (isBinary || !bucket.take()) return;
      const message = parsePeerMessage(rawToString(data));
      if (message) peers.handle(id, message);
    });
    ws.on('close', () => {
      peers.unregister(id, adapter);
      release(ip);
    });
    ws.on('error', (error) => log(`peer socket error ${error.message}`));
  }

  const reject = (socket: Duplex, status: string): void => {
    socket.write(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  };

  const heartbeat = setInterval(() => {
    for (const server of [appServer, peerServer]) {
      for (const ws of server.clients) {
        if (alive.get(ws) === false) {
          ws.terminate(); // no pong and no traffic for a full cycle: half-open connection
          continue;
        }
        alive.set(ws, false);
        ws.ping();
      }
    }
  }, HEARTBEAT_MS);
  const pubsubSweep = setInterval(() => pubsub.sweep(), 30_000);
  const peerSweep = setInterval(() => peers.sweep(), 1_000);
  for (const timer of [heartbeat, pubsubSweep, peerSweep]) timer.unref();

  return {
    pubsub,
    peers,

    handleUpgrade(request, socket, head) {
      const origin = request.headers.origin;
      // Browsers always send Origin; refusing unknown ones stops other sites from opening our sockets
      if (origin && !options.allowedOrigins.has(origin))
        return reject(socket, '403 Forbidden');

      const pathname = new URL(request.url ?? '/', 'http://gateway').pathname;
      const target =
        pathname === '/socket'
          ? appServer
          : pathname === '/peer/peerjs'
            ? peerServer
            : null;
      if (!target) return reject(socket, '404 Not Found');

      const ip = ipOf(request);
      if (
        total >= options.maxConnections ||
        (perIp.get(ip) ?? 0) >= options.maxConnectionsPerIp
      )
        return reject(socket, '503 Service Unavailable');
      total++;
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);

      target.handleUpgrade(request, socket, head, (ws) => {
        if (target === appServer) onAppConnection(ws, ip);
        else onPeerConnection(ws, request, ip);
      });
    },

    stats() {
      return {
        connections: total,
        socketConnections: appServer.clients.size,
        peerConnections: peerServer.clients.size,
        channels: pubsub.channelCount,
        peers: peers.size,
      };
    },

    async close() {
      clearInterval(heartbeat);
      clearInterval(pubsubSweep);
      clearInterval(peerSweep);
      for (const server of [appServer, peerServer]) {
        for (const ws of server.clients) ws.close(1001, 'server shutting down');
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
