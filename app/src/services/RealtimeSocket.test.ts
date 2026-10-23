import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeSocket } from './RealtimeSocket';
import type { SocketLike } from './RealtimeSocket';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, any>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(value: object) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  /** The network went away: the browser reports a close. */
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
  frames(type: string) {
    return this.sent.filter((frame) => frame['t'] === type);
  }
}

function setup(options: { random?: () => number; pingIntervalMs?: number; pongTimeoutMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const onGap = vi.fn();
  const socket = new RealtimeSocket({
    url: 'wss://example.test/socket',
    createSocket: () => {
      const created = new FakeSocket();
      sockets.push(created);
      return created;
    },
    random: options.random ?? (() => 1), // always the longest jitter: makes delays predictable
    pingIntervalMs: options.pingIntervalMs ?? 10_000,
    pongTimeoutMs: options.pongTimeoutMs ?? 8_000,
    onGap,
  });
  return { socket, sockets, onGap, latest: () => sockets[sockets.length - 1]! };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('RealtimeSocket', () => {
  it('does not connect until something needs the socket', () => {
    const { sockets } = setup();
    expect(sockets).toHaveLength(0);
  });

  it('says hello and subscribes once the connection opens, then delivers messages', () => {
    const { socket, latest } = setup();
    const handler = vi.fn();
    socket.subscribe('/raiseHand/m1', handler);
    latest().open();

    expect(latest().frames('hi')[0]).toMatchObject({ t: 'hi', sid: expect.any(String) });
    expect(latest().frames('sub')[0]).toMatchObject({ c: '/raiseHand/m1', since: 0 });

    latest().receive({ t: 'm', c: '/raiseHand/m1', s: 1, d: 'peer-a' });
    expect(handler).toHaveBeenCalledWith('peer-a');
  });

  it('ignores messages it has already seen (replay overlap after a reconnect)', () => {
    const { socket, latest } = setup();
    const handler = vi.fn();
    socket.subscribe('/raiseHand/m1', handler);
    latest().open();
    latest().receive({ t: 'm', c: '/raiseHand/m1', s: 1, d: 'a' });
    latest().receive({ t: 'm', c: '/raiseHand/m1', s: 2, d: 'b' });
    latest().receive({ t: 'm', c: '/raiseHand/m1', s: 2, d: 'b' });
    latest().receive({ t: 'm', c: '/raiseHand/m1', s: 1, d: 'a' });
    expect(handler.mock.calls.map(([value]) => value)).toEqual(['a', 'b']);
  });

  it('reconnects with exponential backoff and resumes from the last sequence it saw', () => {
    const { socket, sockets, latest } = setup();
    socket.subscribe('/whiteboardDrawingAdd/m1', vi.fn());
    latest().open();
    latest().receive({ t: 'm', c: '/whiteboardDrawingAdd/m1', s: 41, d: {} });

    latest().drop();
    expect(socket.status).toBe('reconnecting');
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(249);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1); // first retry after <= 250 ms
    expect(sockets).toHaveLength(2);

    latest().drop(); // fails again before saying hello: next ceiling is 500 ms
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    latest().open();
    expect(socket.status).toBe('open');
    expect(latest().frames('sub')[0]).toMatchObject({ c: '/whiteboardDrawingAdd/m1', since: 41 });
  });

  it('caps the backoff and jitters it so a crowd does not reconnect in lockstep', () => {
    const { socket, sockets, latest } = setup({ random: () => 1 });
    socket.subscribe('/raiseHand/m1', vi.fn());
    for (let attempt = 0; attempt < 12; attempt++) {
      latest().drop();
      vi.advanceTimersByTime(10_000); // never longer than the cap
    }
    expect(sockets).toHaveLength(13);

    const low = setup({ random: () => 0 });
    low.socket.subscribe('/raiseHand/m1', vi.fn());
    low.latest().drop();
    vi.advanceTimersByTime(0);
    expect(low.sockets).toHaveLength(2); // lowest jitter retries at once
  });

  it('queues publishes while offline and re-sends the unacknowledged ones after reconnecting', () => {
    const { socket, sockets, latest } = setup();
    socket.publish('/raiseHand/m1', 'first'); // not connected yet
    latest().open();
    expect(latest().frames('pub')).toHaveLength(1);
    const firstId = latest().frames('pub')[0]!['i'];

    latest().receive({ t: 'a', i: firstId }); // acknowledged: will not be re-sent
    socket.publish('/raiseHand/m1', 'second'); // sent, but the connection dies before the ack
    latest().drop();
    socket.publish('/raiseHand/m1', 'third'); // while offline
    vi.advanceTimersByTime(250);
    expect(sockets).toHaveLength(2);
    latest().open();

    const resent = latest().frames('pub').map((frame) => frame['d']);
    expect(resent).toEqual(['second', 'third']);
  });

  it('does not keep retrying a publish the server refused', () => {
    const { socket, latest } = setup();
    socket.publish('/memberRemove/m1', 'someone');
    latest().open();
    const id = latest().frames('pub')[0]!['i'];
    latest().receive({ t: 'err', code: 'forbidden', i: id });
    latest().drop();
    vi.advanceTimersByTime(250);
    latest().open();
    expect(latest().frames('pub')).toHaveLength(0);
  });

  it('re-identifies itself on every connection so host-only actions keep working', () => {
    const { socket, latest } = setup();
    socket.identify('hostpeer01', 'token-123456');
    latest().open();
    expect(latest().frames('hi')[0]).toMatchObject({ peerId: 'hostpeer01', token: 'token-123456' });
    latest().drop();
    vi.advanceTimersByTime(250);
    latest().open();
    expect(latest().frames('hi')[0]).toMatchObject({ peerId: 'hostpeer01', token: 'token-123456' });
  });

  it('notices a dead connection through the heartbeat and replaces it', () => {
    const { socket, sockets, latest } = setup({ pingIntervalMs: 1000, pongTimeoutMs: 800 });
    socket.subscribe('/raiseHand/m1', vi.fn());
    latest().open();

    vi.advanceTimersByTime(1000);
    expect(latest().frames('ping')).toHaveLength(1);
    latest().receive({ t: 'pong', n: 1 }); // answered: healthy
    vi.advanceTimersByTime(900);
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(1100); // next ping goes unanswered
    expect(socket.status).toBe('reconnecting');
    vi.advanceTimersByTime(250);
    expect(sockets).toHaveLength(2);
  });

  it('reports when the server could not replay everything that was missed', () => {
    const { socket, onGap, latest } = setup();
    socket.subscribe('/whiteboardDrawingAdd/m1', vi.fn());
    latest().open();
    latest().receive({ t: 'ok', c: '/whiteboardDrawingAdd/m1', s: 9, r: 3, g: true });
    expect(onGap).toHaveBeenCalledWith('/whiteboardDrawingAdd/m1');
  });

  it('stops for good when closed', () => {
    const { socket, sockets, latest } = setup();
    socket.subscribe('/raiseHand/m1', vi.fn());
    latest().open();
    socket.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(socket.status).toBe('closed');
  });
});
