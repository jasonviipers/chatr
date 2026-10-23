/**
 * Client for the API's WebSocket gateway (replaces faye). Built to survive bad networks:
 *
 *  - reconnects with jittered exponential backoff (and immediately when the browser says it is back online);
 *  - detects half-open connections with a heartbeat instead of waiting minutes for TCP to give up;
 *  - re-subscribes after every reconnect asking for what it missed (`since`), so nothing published
 *    during a short outage is lost;
 *  - keeps every publish until the server acknowledges it and re-sends the unacknowledged ones after a
 *    reconnect (the server de-duplicates by session + message id, so a retry is never delivered twice).
 */

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RealtimeSocketOptions {
  url: string;
  createSocket?: (url: string) => SocketLike;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxOutbox?: number;
  random?: () => number;
  onStatus?: (status: SocketStatus) => void;
  /** The server no longer has everything this client missed; resync application state. */
  onGap?: (channel: string) => void;
}

/** Told when the server took a publish (the user can see 'sent') or refused it (the user can see 'not sent'). */
export interface PublishCallbacks {
  onAck?: () => void;
  onRejected?: (code: string) => void;
}

interface Subscription {
  handler: (data: any) => void;
  lastSeq: number;
}

const OPEN = 1;

export class RealtimeSocket {
  private readonly url: string;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxOutbox: number;
  private readonly random: () => number;
  private readonly onStatus: ((status: SocketStatus) => void) | undefined;
  private readonly onGap: ((channel: string) => void) | undefined;

  private socket: SocketLike | null = null;
  private currentStatus: SocketStatus = 'idle';
  private wantOpen = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly sid = RealtimeSocket.newSessionId();
  private nextMessageId = 0;
  private identity: { peerId: string; token: string } | null = null;
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly outbox = new Map<number, string>();
  private readonly callbacks = new Map<number, PublishCallbacks>();

  constructor(options: RealtimeSocketOptions) {
    this.url = options.url;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.pingIntervalMs = options.pingIntervalMs ?? 10_000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 8_000;
    this.backoffBaseMs = options.backoffBaseMs ?? 250;
    this.backoffMaxMs = options.backoffMaxMs ?? 10_000;
    this.maxOutbox = options.maxOutbox ?? 200;
    this.random = options.random ?? Math.random;
    this.onStatus = options.onStatus;
    this.onGap = options.onGap;

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.nudge());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.nudge();
      });
    }
  }

  get status(): SocketStatus {
    return this.currentStatus;
  }

  /** Connects on first use (visitors who never join a meeting never open a socket). */
  private ensureConnected(): void {
    if (this.wantOpen) return;
    this.wantOpen = true;
    this.open();
  }

  subscribe(channel: string, handler: (data: any) => void): void {
    this.ensureConnected();
    this.subscriptions.set(channel, { handler, lastSeq: 0 });
    this.sendIfOpen({ t: 'sub', c: channel });
  }

  unsubscribe(channel: string): void {
    if (!this.subscriptions.delete(channel)) return;
    this.sendIfOpen({ t: 'unsub', c: channel });
  }

  publish(channel: string, data: unknown, callbacks?: PublishCallbacks): void {
    this.ensureConnected();
    const i = ++this.nextMessageId;
    const frame = JSON.stringify({ t: 'pub', c: channel, i, d: data });
    this.outbox.set(i, frame);
    if (callbacks) this.callbacks.set(i, callbacks);
    if (this.outbox.size > this.maxOutbox) {
      const oldest = this.outbox.keys().next().value;
      if (oldest !== undefined) {
        this.outbox.delete(oldest);
        this.callbacks.get(oldest)?.onRejected?.('dropped'); // too many waiting: the oldest one gives way
        this.callbacks.delete(oldest);
      }
    }
    this.sendRaw(frame);
  }

  /** Proves to the server that this tab owns a signalling peer id (needed for host-only actions). */
  identify(peerId: string, token: string): void {
    this.identity = { peerId, token };
    this.ensureConnected();
    this.sendIfOpen(this.hello());
  }

  close(): void {
    this.wantOpen = false;
    this.clearTimers();
    this.detach();
    this.setStatus('closed');
  }

  // ---- internals ---------------------------------------------------------------------------------

  private static newSessionId(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  private hello() {
    return { t: 'hi', sid: this.sid, ...(this.identity ?? {}) };
  }

  private open(): void {
    if (!this.wantOpen) return;
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');

    let socket: SocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.setStatus('open');
      this.sendRaw(JSON.stringify(this.hello()));
      for (const [channel, subscription] of this.subscriptions) {
        this.sendRaw(JSON.stringify({ t: 'sub', c: channel, since: subscription.lastSeq }));
      }
      for (const frame of this.outbox.values()) this.sendRaw(frame);
      this.startHeartbeat();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.onFrame(event.data);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.handleLost();
    };
    socket.onerror = () => {
      // a close event follows; nothing to do here
    };
  }

  private onFrame(raw: unknown): void {
    if (typeof raw !== 'string') return;
    this.clearPongTimer(); // anything from the server proves the connection is alive

    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    switch (message.t) {
      case 'hi':
        this.attempts = 0; // the connection is really usable now
        break;
      case 'm': {
        const subscription = this.subscriptions.get(message.c);
        if (!subscription || message.s <= subscription.lastSeq) return; // unsubscribed, or already seen
        subscription.lastSeq = message.s;
        try {
          subscription.handler(message.d);
        } catch (error) {
          console.error('realtime handler failed', error);
        }
        break;
      }
      case 'ok': {
        const subscription = this.subscriptions.get(message.c);
        if (subscription && typeof message.s === 'number' && message.s > subscription.lastSeq) subscription.lastSeq = message.s;
        if (message.g === true) this.onGap?.(message.c);
        break;
      }
      case 'a':
        this.outbox.delete(message.i);
        this.callbacks.get(message.i)?.onAck?.();
        this.callbacks.delete(message.i);
        break;
      case 'err':
        // a refused publish will be refused again: do not keep retrying it
        if (typeof message.i === 'number') {
          this.outbox.delete(message.i);
          this.callbacks.get(message.i)?.onRejected?.(String(message.code ?? 'refused'));
          this.callbacks.delete(message.i);
        }
        break;
      default:
        break;
    }
  }

  private sendIfOpen(value: object): void {
    if (this.socket?.readyState === OPEN) this.sendRaw(JSON.stringify(value));
  }

  private sendRaw(frame: string): void {
    if (this.socket?.readyState !== OPEN) return; // queued in the outbox / re-subscribed on reconnect
    try {
      this.socket.send(frame);
    } catch {
      // the close handler will deal with it
    }
  }

  private handleLost(): void {
    this.detach();
    this.stopHeartbeat();
    if (!this.wantOpen) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.setStatus('reconnecting');
    // full jitter: spreads a crowd of clients that lost the server at the same moment
    const ceiling = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** this.attempts);
    const delay = Math.floor(this.random() * ceiling);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  /** Network came back / tab woke up: check the connection now instead of waiting for the next heartbeat. */
  private nudge(): void {
    if (!this.wantOpen) return;
    if (this.socket?.readyState === OPEN) {
      this.sendIfOpen({ t: 'ping', n: 0 });
      this.armPongTimer(Math.min(this.pongTimeoutMs, 3_000));
      return;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.attempts = 0;
    this.open();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      this.sendIfOpen({ t: 'ping', n: Date.now() });
      this.armPongTimer(this.pongTimeoutMs);
    }, this.pingIntervalMs);
  }

  private armPongTimer(ms: number): void {
    if (this.pongTimer) return;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      // no answer: the connection is dead even though the browser has not noticed yet
      const dead = this.socket;
      this.detach();
      try {
        dead?.close();
      } catch {
        // already gone
      }
      this.handleLost();
    }, ms);
  }

  private clearPongTimer(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.clearPongTimer();
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private detach(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close();
    } catch {
      // already gone
    }
  }

  private setStatus(status: SocketStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.onStatus?.(status);
  }
}
