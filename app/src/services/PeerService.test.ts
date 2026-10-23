import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

class Emitter {
  handlers = new Map<string, Handler[]>();
  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  emit(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

class FakeConnection {
  iceConnectionState = 'new';
  private listeners: (() => void)[] = [];
  addEventListener(_type: string, listener: () => void) {
    this.listeners.push(listener);
  }
  removeEventListener(_type: string, listener: () => void) {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  move(state: string) {
    this.iceConnectionState = state;
    for (const listener of [...this.listeners]) listener();
  }
}

/** PeerJS' MediaConnection: it only says "close" for calls that were open. */
class FakeCall extends Emitter {
  static count = 0;
  connectionId = `conn${++FakeCall.count}`;
  open = false;
  peerConnection = new FakeConnection();
  constructor(public peer: string) {
    super();
  }
  answer() {
    this.open = true;
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }
  /** the other side answered and media flows */
  connect() {
    this.open = true;
    this.peerConnection.move('connected');
  }
}

class FakePeer extends Emitter {
  static last: FakePeer;
  open = true;
  placed: FakeCall[] = [];
  constructor() {
    super();
    FakePeer.last = this;
  }
  call(peer: string) {
    const call = new FakeCall(peer);
    this.placed.push(call);
    return call;
  }
  destroy() {}
}

vi.mock('peerjs', () => ({ default: FakePeer }));
vi.mock('./AlertService', () => ({ default: { push: vi.fn() } }));
vi.mock('./SocketService', () => ({ default: { identify: vi.fn() } }));
vi.mock('./network/IceRestart', () => ({ iceRestart: { register: vi.fn(), unregister: vi.fn(), listen: vi.fn() } }));
vi.mock('./network/NetworkMonitor', () => ({ networkMonitor: { attach: vi.fn(), detach: vi.fn(), detachAll: vi.fn() } }));
vi.mock('../routes', () => ({ default: { home: { path: '/home' } } })); // the real one pulls in every page

const { default: PeerService } = await import('./PeerService');
const { default: AlertService } = await import('./AlertService');

const stream = {} as MediaStream;
const unavailable = (peer: string) => ({ type: 'peer-unavailable', message: `Could not connect to peer ${peer}` });

describe('PeerService', () => {
  let history: { push: ReturnType<typeof vi.fn> };
  let service: InstanceType<typeof PeerService>;
  let peer: FakePeer;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter
    vi.mocked(AlertService.push).mockClear();
    history = { push: vi.fn() };
    service = new PeerService();
    service.handleErrors(history as never);
    peer = FakePeer.last;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Calls `id` and gets the call connected, like a normal join. */
  function join(id: string, onCall: (call: unknown) => void = () => undefined) {
    service.call(id, stream, (call) => onCall(call));
    const call = peer.placed.at(-1) as FakeCall;
    call.connect();
    return call;
  }

  describe('errors', () => {
    it('sends the user home when the meeting cannot be found', () => {
      service.call('missing-meeting', stream, () => undefined);
      peer.emit('error', unavailable('missing-meeting'));
      expect(history.push).toHaveBeenCalledWith('/home');
      expect(AlertService.push).toHaveBeenCalledWith("Meeting ID doesn't exist");
    });

    it('keeps a running meeting going when another participant has vanished', () => {
      join('host');
      peer.emit('error', unavailable('someone-who-closed-their-browser'));
      expect(history.push).not.toHaveBeenCalled();
      expect(AlertService.push).not.toHaveBeenCalled();
    });

    it('does not end the meeting for a participant we know either, even when no call is up at that moment', () => {
      const call = join('host');
      call.peerConnection.move('disconnected');
      peer.emit('error', unavailable('host'));
      expect(history.push).not.toHaveBeenCalled();
    });

    it('is fatal again for an unknown peer once the last live call is gone', () => {
      const call = join('host');
      call.close();
      service.forget('host'); // nobody left to wait for
      peer.emit('error', unavailable('stranger'));
      expect(history.push).toHaveBeenCalledWith('/home');
    });
  });

  describe('re-dialing a call that dropped for good', () => {
    it('places it again after a short delay and hands the new call to the app', () => {
      const seen: unknown[] = [];
      const first = join('host', (call) => seen.push(call));
      first.close(); // ICE failed / the dead-call timer ended it

      vi.advanceTimersByTime(1_400);
      expect(peer.placed).toHaveLength(1);
      vi.advanceTimersByTime(200);
      expect(peer.placed).toHaveLength(2);
      expect(seen).toEqual(peer.placed); // the app wires up every call it is given
    });

    it('does nothing about a first call that never connected (a failed join, not a drop)', () => {
      service.call('wrong-meeting', stream, () => undefined);
      peer.emit('error', unavailable('wrong-meeting'));
      vi.advanceTimersByTime(120_000);
      expect(peer.placed).toHaveLength(1);
    });

    it('keeps trying with growing delays, abandoning an attempt nobody answers', () => {
      join('host').close();
      vi.advanceTimersByTime(1_500);
      expect(peer.placed).toHaveLength(2); // attempt 1, never answered

      vi.advanceTimersByTime(25_000);
      expect(peer.placed).toHaveLength(2); // abandoned, next one is planned 3 s later
      vi.advanceTimersByTime(3_000);
      expect(peer.placed).toHaveLength(3);

      vi.advanceTimersByTime(25_000 + 6_000);
      expect(peer.placed).toHaveLength(4);
    });

    it('counts "that peer is not reachable" as a failed attempt at once, without kicking anyone out', () => {
      join('host').close();
      vi.advanceTimersByTime(1_500);
      expect(peer.placed).toHaveLength(2);

      peer.emit('error', unavailable('host'));
      expect(history.push).not.toHaveBeenCalled();
      expect(AlertService.push).not.toHaveBeenCalled();

      vi.advanceTimersByTime(3_000); // no need to wait for the 25 s attempt timeout
      expect(peer.placed).toHaveLength(3);
    });

    it('starts over, with short delays, once the call is back', () => {
      join('host').close();
      vi.advanceTimersByTime(1_500);
      (peer.placed.at(-1) as FakeCall).connect(); // the re-dial worked

      (peer.placed.at(-1) as FakeCall).close(); // and drops again
      vi.advanceTimersByTime(1_500);
      expect(peer.placed).toHaveLength(3); // 1.5 s again, not the next step of the old schedule
    });

    it('stops when the participant said goodbye', () => {
      join('host').close();
      service.forget('host');
      vi.advanceTimersByTime(120_000);
      expect(peer.placed).toHaveLength(1);
    });

    it('stops when we leave the meeting', () => {
      join('host').close();
      service.disconnect();
      vi.advanceTimersByTime(120_000);
      expect(peer.placed).toHaveLength(1);
    });

    it('waits for the signalling link instead of dialing into the void', () => {
      join('host').close();
      peer.open = false;
      vi.advanceTimersByTime(8_000);
      expect(peer.placed).toHaveLength(1);

      peer.open = true;
      vi.advanceTimersByTime(1_200);
      expect(peer.placed).toHaveLength(2);
    });

    it('gives up after ten minutes and says who could not be reached', () => {
      const gaveUp = vi.fn();
      service.onRedialGiveUp(gaveUp);
      join('host').close();

      vi.advanceTimersByTime(9 * 60_000);
      expect(gaveUp).not.toHaveBeenCalled();
      vi.advanceTimersByTime(3 * 60_000);
      expect(gaveUp).toHaveBeenCalledWith('host');

      const placed = peer.placed.length;
      vi.advanceTimersByTime(10 * 60_000);
      expect(peer.placed).toHaveLength(placed); // and it really stopped
    });

    it('does not place a second call to somebody it is already calling, but calls at once when asked while waiting', () => {
      join('host');
      service.call('host', stream, () => undefined); // e.g. a second "someone joined" event
      expect(peer.placed).toHaveLength(1);

      (peer.placed[0] as FakeCall).close();
      service.call('host', stream, () => undefined); // asked while a re-dial is waiting: no need to wait
      expect(peer.placed).toHaveLength(2);
      vi.advanceTimersByTime(2_000);
      expect(peer.placed).toHaveLength(2); // the timer that was waiting did not fire a duplicate
    });

    it('always uses the stream that is current when it dials', () => {
      let current = { id: 'camera' } as unknown as MediaStream;
      const used: unknown[] = [];
      const original = peer.call.bind(peer);
      peer.call = ((id: string, s: unknown) => {
        used.push(s);
        return original(id);
      }) as typeof peer.call;

      service.call('host', stream, () => undefined, () => current);
      (peer.placed[0] as FakeCall).connect();
      (peer.placed[0] as FakeCall).close();
      current = { id: 'screen' } as unknown as MediaStream; // screen sharing started meanwhile
      vi.advanceTimersByTime(1_600);

      expect(used).toEqual([{ id: 'camera' }, { id: 'screen' }]);
    });
  });

  describe('calls that end', () => {
    it('tells the app once, also for an attempt PeerJS never reports', () => {
      join('host').close();
      vi.advanceTimersByTime(1_500);
      const attempt = peer.placed.at(-1) as FakeCall;
      const ended = vi.fn();
      service.onCallEnded(attempt as never, ended);

      vi.advanceTimersByTime(25_000); // nobody answered
      vi.advanceTimersByTime(25_000);
      expect(ended).toHaveBeenCalledTimes(1);
    });

    it('a participant who calls again replaces their earlier call to us, but not the call we placed to them', () => {
      const outgoing = join('friend');
      const endedOutgoing = vi.fn();
      service.onCallEnded(outgoing as never, endedOutgoing);

      const first = new FakeCall('friend');
      service.answerCall(first as never, stream);
      const endedFirst = vi.fn();
      service.onCallEnded(first as never, endedFirst);

      const second = new FakeCall('friend'); // their network died and came back: they dial us again
      service.answerCall(second as never, stream);

      expect(endedFirst).toHaveBeenCalledTimes(1);
      expect(endedOutgoing).not.toHaveBeenCalled();
      expect(first.open).toBe(false);
      expect(second.open).toBe(true);
    });
  });
});
