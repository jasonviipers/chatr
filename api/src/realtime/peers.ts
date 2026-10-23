import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * WebRTC signalling that speaks the PeerJS wire protocol, replacing the `peer` server package.
 * The browser keeps using the PeerJS client; only the server changed. It relays offers, answers and
 * ICE candidates between peers and never sees any media.
 */

export interface PeerSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface PeerMessage {
  type: string;
  src?: string;
  dst?: string;
  payload?: unknown;
}

interface PeerClient {
  id: string;
  token: string;
  socket: PeerSocket;
  lastSeen: number;
}

interface Queued {
  message: PeerMessage;
  at: number;
}

export const PEER_KEY = 'peerjs';
export const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const PEER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;

const RELAYED = new Set(['OFFER', 'ANSWER', 'CANDIDATE', 'LEAVE', 'EXPIRE']);

const digest = (value: string) => createHash('sha256').update(value).digest();

export function tokensMatch(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export function parsePeerMessage(raw: string): PeerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { type, dst, payload } = value as Record<string, unknown>;
  if (typeof type !== 'string') return null;
  if (
    dst !== undefined &&
    (typeof dst !== 'string' || !PEER_ID_PATTERN.test(dst))
  )
    return null;
  return {
    type,
    ...(dst !== undefined ? { dst } : {}),
    ...(payload !== undefined ? { payload } : {}),
  };
}

export interface PeerRegistryOptions {
  /** How long a message to an unreachable peer waits before the sender is told the peer expired. */
  expireMs?: number;
  /** A peer that sends nothing (not even a heartbeat) for this long is dropped. */
  aliveTimeoutMs?: number;
  now?: () => number;
}

export class PeerRegistry {
  private readonly clients = new Map<string, PeerClient>();
  private readonly queue = new Map<string, Queued[]>();
  private readonly expireMs: number;
  private readonly aliveTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: PeerRegistryOptions = {}) {
    this.expireMs = options.expireMs ?? 5_000;
    this.aliveTimeoutMs = options.aliveTimeoutMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.clients.size;
  }

  /** 64 random bits: unguessable, 11 url-safe characters like the ids the old server produced. */
  generateId(): string {
    for (;;) {
      const id = randomBytes(8).toString('base64url');
      if (!this.clients.has(id)) return id;
    }
  }

  /**
   * `ok` registers (or re-registers after a reconnect with the same token); `taken` means another
   * client owns the id. The token is what proves ownership, so nobody can hijack a meeting id.
   */
  register(id: string, token: string, socket: PeerSocket): 'ok' | 'taken' {
    const existing = this.clients.get(id);
    if (existing) {
      if (!tokensMatch(existing.token, token)) return 'taken';
      if (existing.socket !== socket)
        existing.socket.close(1000, 'replaced by a newer connection');
    }
    this.clients.set(id, { id, token, socket, lastSeen: this.now() });

    const waiting = this.queue.get(id);
    if (waiting) {
      this.queue.delete(id);
      for (const { message } of waiting) socket.send(JSON.stringify(message));
    }
    return 'ok';
  }

  unregister(id: string, socket: PeerSocket): void {
    if (this.clients.get(id)?.socket === socket) this.clients.delete(id);
  }

  /** True only while `id` is connected and `token` is the one it registered with. */
  verify(id: string, token: string): boolean {
    const client = this.clients.get(id);
    return client !== undefined && tokensMatch(client.token, token);
  }

  handle(srcId: string, message: PeerMessage): void {
    const src = this.clients.get(srcId);
    if (!src) return;
    src.lastSeen = this.now();

    if (message.type === 'HEARTBEAT') return;
    if (!RELAYED.has(message.type)) return;

    if (message.type === 'LEAVE' && message.dst === undefined) {
      this.clients.delete(srcId);
      return;
    }
    if (message.dst === undefined) return;

    const outgoing: PeerMessage = {
      type: message.type,
      src: srcId,
      dst: message.dst,
      ...(message.payload !== undefined ? { payload: message.payload } : {}),
    };
    const target = this.clients.get(message.dst);
    if (target) {
      target.socket.send(JSON.stringify(outgoing));
    } else if (message.type !== 'LEAVE' && message.type !== 'EXPIRE') {
      const waiting = this.queue.get(message.dst) ?? [];
      waiting.push({ message: outgoing, at: this.now() });
      this.queue.set(message.dst, waiting);
    }
  }

  /** Expires queued messages (telling the sender) and drops silent peers. Call about once a second. */
  sweep(): void {
    const now = this.now();

    for (const [dst, waiting] of this.queue) {
      const fresh: Queued[] = [];
      for (const entry of waiting) {
        if (now - entry.at < this.expireMs) {
          fresh.push(entry);
          continue;
        }
        const sender = entry.message.src
          ? this.clients.get(entry.message.src)
          : undefined;
        sender?.socket.send(
          JSON.stringify({ type: 'EXPIRE', src: dst, dst: entry.message.src }),
        );
      }
      if (fresh.length > 0) this.queue.set(dst, fresh);
      else this.queue.delete(dst);
    }

    for (const client of this.clients.values()) {
      if (now - client.lastSeen > this.aliveTimeoutMs) {
        this.clients.delete(client.id);
        client.socket.close(1001, 'heartbeat timeout');
      }
    }
  }
}
