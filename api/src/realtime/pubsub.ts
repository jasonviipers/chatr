/**
 * Channel based publish/subscribe with replay, replacing the faye (Bayeux) server.
 *
 * Built for flaky networks:
 *  - every message on a channel gets a sequence number; a client that reconnects says which
 *    number it saw last (`since`) and gets the ones it missed (within a short window);
 *  - publishes carry a client-side id, are acknowledged, and are de-duplicated, so a client can
 *    safely re-send anything that was not acknowledged before the connection dropped.
 */

export interface Connection {
  readonly id: number;
  /** Stable id of the browser tab across reconnects (used for publish de-duplication). */
  sid: string | null;
  /** Peer id proven through the signalling token (the host's peer id is the meeting id). */
  peerId: string | null;
  readonly channels: Set<string>;
  send(frame: string): void;
}

interface Entry {
  seq: number;
  at: number;
  frame: string;
}

interface Channel {
  seq: number;
  readonly subscribers: Set<Connection>;
  readonly history: Entry[];
  lastActivity: number;
}

export interface PubSubOptions {
  historySize?: number;
  historyTtlMs?: number;
  dedupeSize?: number;
  now?: () => number;
}

export type SubscribeResult = { replayed: number; seq: number; gap: boolean };

export class PubSub {
  private readonly channels = new Map<string, Channel>();
  private readonly seenBySession = new Map<
    string,
    { ids: Set<number>; order: number[]; touched: number }
  >();
  private readonly historySize: number;
  private readonly historyTtlMs: number;
  private readonly dedupeSize: number;
  private readonly now: () => number;

  constructor(options: PubSubOptions = {}) {
    this.historySize = options.historySize ?? 256;
    this.historyTtlMs = options.historyTtlMs ?? 120_000;
    this.dedupeSize = options.dedupeSize ?? 512;
    this.now = options.now ?? Date.now;
  }

  get channelCount(): number {
    return this.channels.size;
  }

  subscribe(conn: Connection, name: string, since?: number): SubscribeResult {
    let channel = this.channels.get(name);
    if (!channel) {
      channel = {
        seq: 0,
        subscribers: new Set(),
        history: [],
        lastActivity: this.now(),
      };
      this.channels.set(name, channel);
    }
    channel.subscribers.add(conn);
    conn.channels.add(name);

    let replayed = 0;
    let gap = false;
    if (since !== undefined && since < channel.seq) {
      const oldest = channel.history[0];
      // history is contiguous; if the first kept entry is newer than since + 1 something was dropped
      gap = oldest === undefined ? true : oldest.seq > since + 1;
      for (const entry of channel.history) {
        if (entry.seq > since) {
          conn.send(entry.frame);
          replayed++;
        }
      }
    }
    return { replayed, seq: channel.seq, gap };
  }

  unsubscribe(conn: Connection, name: string): void {
    conn.channels.delete(name);
    this.channels.get(name)?.subscribers.delete(conn);
  }

  /** Removes a closed connection from every channel it was in. */
  drop(conn: Connection): void {
    for (const name of conn.channels)
      this.channels.get(name)?.subscribers.delete(conn);
    conn.channels.clear();
  }

  /**
   * Delivers `data` to every subscriber of the channel (the publisher included, like faye did).
   * Returns false when this (sid, id) pair was already published, so the caller still acks it.
   */
  publish(
    name: string,
    data: unknown,
    sid: string | null,
    messageId: number | undefined,
  ): { seq: number; duplicate: boolean } {
    if (
      sid !== null &&
      messageId !== undefined &&
      this.seenBefore(sid, messageId)
    ) {
      return { seq: this.channels.get(name)?.seq ?? 0, duplicate: true };
    }

    let channel = this.channels.get(name);
    if (!channel) {
      channel = {
        seq: 0,
        subscribers: new Set(),
        history: [],
        lastActivity: this.now(),
      };
      this.channels.set(name, channel);
    }

    const now = this.now();
    const seq = ++channel.seq;
    const frame = JSON.stringify({ t: 'm', c: name, s: seq, d: data });
    channel.history.push({ seq, at: now, frame });
    if (channel.history.length > this.historySize)
      channel.history.splice(0, channel.history.length - this.historySize);
    channel.lastActivity = now;

    for (const subscriber of channel.subscribers) subscriber.send(frame);
    return { seq, duplicate: false };
  }

  /** Drops expired history and empty channels; call periodically. */
  sweep(): void {
    const now = this.now();
    for (const [name, channel] of this.channels) {
      const cutoff = now - this.historyTtlMs;
      let expired = 0;
      while (
        expired < channel.history.length &&
        (channel.history[expired]?.at ?? now) < cutoff
      )
        expired++;
      if (expired > 0) channel.history.splice(0, expired);
      if (channel.subscribers.size === 0 && channel.history.length === 0)
        this.channels.delete(name);
    }
    for (const [sid, seen] of this.seenBySession) {
      if (now - seen.touched > 10 * 60_000) this.seenBySession.delete(sid);
    }
  }

  private seenBefore(sid: string, messageId: number): boolean {
    let seen = this.seenBySession.get(sid);
    if (!seen) {
      seen = { ids: new Set(), order: [], touched: this.now() };
      this.seenBySession.set(sid, seen);
    }
    seen.touched = this.now();
    if (seen.ids.has(messageId)) return true;
    seen.ids.add(messageId);
    seen.order.push(messageId);
    if (seen.order.length > this.dedupeSize) {
      const evicted = seen.order.shift();
      if (evicted !== undefined) seen.ids.delete(evicted);
    }
    return false;
  }
}
