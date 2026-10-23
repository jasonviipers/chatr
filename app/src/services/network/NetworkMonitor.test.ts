import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { networkMonitor } from './NetworkMonitor';

/** The slice of RTCPeerConnection the monitor touches. */
class FakePc {
  iceConnectionState = 'connected';
  connectionState = 'connected';
  signalingState = 'stable';
  private listeners: (() => void)[] = [];

  addEventListener(_type: string, listener: () => void) {
    this.listeners.push(listener);
  }
  removeEventListener(_type: string, listener: () => void) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  getSenders() {
    return [];
  }
  getStats() {
    return Promise.resolve(new Map());
  }
  restartIce() {}
  move(state: string) {
    this.iceConnectionState = state;
    for (const listener of this.listeners) listener();
  }
}

describe('NetworkMonitor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    networkMonitor.detachAll();
    vi.useRealTimers();
  });

  const attach = (pc: FakePc, options: { originator: boolean; restart?: () => void; onDead?: () => void }) =>
    networkMonitor.attach(pc as unknown as RTCPeerConnection, options);

  it('restarts a dropped call after a short grace period, and keeps trying with growing delays', () => {
    const pc = new FakePc();
    const restart = vi.fn();
    attach(pc, { originator: true, restart });

    pc.move('disconnected');
    vi.advanceTimersByTime(2_900);
    expect(restart).not.toHaveBeenCalled(); // the browser may heal it alone
    vi.advanceTimersByTime(200);
    expect(restart).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(4_000);
    expect(restart).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10_000);
    expect(restart).toHaveBeenCalledTimes(3);
  });

  it('only the side that placed the call restarts it', () => {
    const pc = new FakePc();
    const restart = vi.fn();
    attach(pc, { originator: false, restart });
    pc.move('disconnected');
    vi.advanceTimersByTime(60_000);
    expect(restart).not.toHaveBeenCalled();
  });

  it('gives up on a call that stays down, on either side, so no frozen picture is left behind', () => {
    for (const originator of [true, false]) {
      const pc = new FakePc();
      const onDead = vi.fn();
      attach(pc, { originator, restart: vi.fn(), onDead });

      pc.move('disconnected');
      vi.advanceTimersByTime(89_000);
      expect(onDead).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_500);
      expect(onDead).toHaveBeenCalledTimes(1);
    }
  });

  it('does not give up on a call that came back', () => {
    const pc = new FakePc();
    const onDead = vi.fn();
    attach(pc, { originator: false, onDead });

    pc.move('disconnected');
    vi.advanceTimersByTime(40_000);
    pc.move('connected');
    vi.advanceTimersByTime(120_000);
    expect(onDead).not.toHaveBeenCalled();

    // and a later drop starts a fresh countdown
    pc.move('disconnected');
    vi.advanceTimersByTime(91_000);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it('stops everything once detached', () => {
    const pc = new FakePc();
    const onDead = vi.fn();
    const restart = vi.fn();
    attach(pc, { originator: true, restart, onDead });
    pc.move('disconnected');
    networkMonitor.detach(pc as unknown as RTCPeerConnection);
    vi.advanceTimersByTime(200_000);
    expect(onDead).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });
});
