import Peer from 'peerjs';
import type { MediaConnection } from 'peerjs';
import { History } from '../components/withRouter/withRouter';
import { includes } from 'lodash';
import { peerServerOptions } from '../config';
import routes from '../routes';
import AlertService from './AlertService';
import { exposeForTests } from './devHooks';
import IceService from './IceService';
import SocketService from './SocketService';
import { iceRestart } from './network/IceRestart';
import { networkMonitor } from './network/NetworkMonitor';
import { optimiseOpus } from './network/opus';
import { LOCKED_NOTICE } from './MeetingStatusService';

/** Delays before each re-dial of a call that dropped for good; the last one repeats. */
const REDIAL_DELAYS_MS = [1_500, 3_000, 6_000, 12_000, 20_000, 30_000];
/** A re-dial that has not connected after this long is abandoned and the next one starts. */
const REDIAL_ATTEMPT_TIMEOUT_MS = 25_000;
/** How long to keep trying to reach someone before concluding they are gone. */
const REDIAL_GIVE_UP_MS = 10 * 60_000;

/** A call this tab placed (to the host, or to a participant who just joined) and keeps alive. */
interface Dial {
  peerId: string;
  stream: () => MediaStream;
  onCall: (call: MediaConnection) => void;
  /** Connected at least once. Only then is a close a drop worth re-dialing (a failed join is not). */
  connected: boolean;
  attempts: number;
  /** When the current outage began (0 while the call is up). */
  since: number;
  call: MediaConnection | null;
  timer: ReturnType<typeof setTimeout> | null;
  attemptTimer: ReturnType<typeof setTimeout> | null;
}

interface Tracked {
  call: MediaConnection;
  originator: boolean;
  /** runs once when the call is over, whether or not PeerJS says so */
  ended: (() => void)[];
  /** tears the call's bookkeeping down (safe to call twice) */
  release: () => void;
}

const isUp = (connection: RTCPeerConnection) =>
  connection.iceConnectionState === 'connected' || connection.iceConnectionState === 'completed';

export default class PeerService {
  private client: Peer;

  /**
   * Proves to the server that this tab owns its peer id (nobody else can take it over or act as the
   * host). PeerJS would otherwise use Math.random(); this one comes from the browser's CSPRNG.
   */
  private readonly token = PeerService.randomToken();

  /** the peer connections of the calls in this meeting (to tell a lost participant from a lost meeting) */
  private readonly connections = new Set<RTCPeerConnection>();
  /** every call that is open, with who placed it */
  private readonly tracked = new Map<string, Tracked>();
  /** everybody this tab has had a call with */
  private readonly knownPeers = new Set<string>();
  /** calls placed by this tab that are brought back when they drop */
  private readonly dials = new Map<string, Dial>();
  /** participants who said goodbye: no point in calling them again */
  private readonly gone = new Set<string>();
  private giveUpHandler: ((peerId: string) => void) | null = null;
  private opened = false;
  private destroyed = false;
  private reconnectAttempts = 0;
  /** the pending retry */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** gives up on an attempt that neither opens nor fails */
  private hangTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.client = new Peer({
      ...peerServerOptions(),
      token: this.token,
      config: { iceServers: IceService.current(), iceCandidatePoolSize: 2 },
    });
    this.keepSignallingAlive();
    exposeForTests('peerService', this);
  }

  private static randomToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /**
   * The link to the signalling server can drop on a bad network while the calls themselves (peer to
   * peer) are fine. Instead of ending the meeting, reconnect with the same id and backoff.
   */
  private keepSignallingAlive(): void {
    // registered before the app's own 'open' handler, so the server knows who we are before we subscribe
    this.client.on('open', (id) => {
      this.reconnectAttempts = 0;
      this.clearTimers();
      SocketService.identify(id, this.token);
      iceRestart.listen(id);
    });
    this.client.on('disconnected', () => this.reconnectSoon());
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.hangTimer) clearTimeout(this.hangTimer);
    this.reconnectTimer = null;
    this.hangTimer = null;
  }

  /** Runs every time the signalling link is lost, including when a reconnect attempt itself fails. */
  private reconnectSoon(): void {
    if (this.destroyed) return;
    if (this.hangTimer) clearTimeout(this.hangTimer); // this attempt ended (failed): no need to wait for it
    this.hangTimer = null;
    if (this.reconnectTimer) return; // a retry is already scheduled

    if (this.opened && this.reconnectAttempts === 0) AlertService.push('Connection lost. Reconnecting...');

    const ceiling = Math.min(10_000, 500 * 2 ** this.reconnectAttempts++);
    const delay = Math.max(300, Math.floor(Math.random() * ceiling));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed || !this.client.disconnected) return;
      try {
        this.client.reconnect();
      } catch {
        return;
      }
      // an attempt that hangs (no answer at all) is abandoned, which triggers the next retry
      this.hangTimer = setTimeout(() => {
        this.hangTimer = null;
        if (!this.destroyed && !this.client.open) this.client.disconnect(); // emits 'disconnected'
      }, 10_000);
    }, delay);
  }

  private getErrorMessage(type: string): string {
    switch (type) {
      case 'browser-incompatible':
        return "Device doesn't support WebRTC";
      case 'disconnected':
        return 'Already disconnected meeting';
      case 'invalid-id':
        return 'Invalid connection ID';
      case 'invalid-key':
        return 'Invalid API key';
      case 'network':
        return "Can't establish network connection";
      case 'peer-unavailable':
        return "Meeting ID doesn't exist";
      case 'ssl-unavailable':
        return "Server doesn't support SSL";
      case 'server-error':
        return 'Unable to reach server';
      case 'socket-error':
        return 'Underlying socket error';
      case 'socket-closed':
        return 'Underlying socket closed';
      case 'unavailable-id':
        return 'Connection ID already taken';
      case 'webrtc':
        return 'WebRTC error';
      default:
        return 'Something went wrong';
    }
  }

  handleErrors(history: History) {
    this.client.on('error', (error) => {
      const { type } = error;
      const message = this.getErrorMessage(type);
      // the server refuses a call into a meeting that was locked after the page was opened
      if (type === 'server-error' && /locked/i.test(error.message ?? '')) {
        AlertService.push(LOCKED_NOTICE);
        history.push(routes.home.path);
        return;
      }
      const transient = type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed';
      // Once the meeting is running, a flaky connection is retried (see keepSignallingAlive), not fatal
      if (this.opened && transient) return;
      if (type === 'peer-unavailable') {
        // A participant who dropped out is "unavailable" to the server too (an offer or candidate sent to them
        // expires). That must not end the meeting for the people who are still in it.
        const peerId = /Could not connect to peer (.+)$/.exec(error.message ?? '')?.[1];
        if (peerId && this.knownPeers.has(peerId)) {
          const dial = this.dials.get(peerId);
          if (dial?.attemptTimer) this.attemptFailed(dial); // a re-dial that found nobody: try again later
          return;
        }
        if (this.hasLiveCall()) return;
      }
      AlertService.push(message);
      const routeErrorTypes = ['network', 'server-error', 'peer-unavailable'];
      const canRoute = includes(routeErrorTypes, type);
      if (canRoute) history.push(routes.home.path);
    });
  }

  /** Fires once, when the meeting id is known. (PeerJS emits `open` again after every reconnect.) */
  onOpen(callback: (localConnectionId: string) => void): void {
    this.client.on('open', (localConnectionId) => {
      if (this.opened) return;
      this.opened = true;
      callback(localConnectionId);
    });
  }

  /**
   * Calls a peer and keeps the call alive: when it drops for good (the network died for longer than ICE
   * restarts can bridge) it is dialed again with growing delays, until the peer says goodbye, answers, or
   * is given up on. `callback` runs for every call placed, so the app can wire up each new one.
   * `stream` is read at every dial, so a screen share that started meanwhile is not lost.
   */
  call(
    peerId: string,
    stream: MediaStream,
    callback: (call: MediaConnection) => void,
    currentStream: () => MediaStream = () => stream,
  ): void {
    const existing = this.dials.get(peerId);
    if (existing && (existing.connected || existing.timer)) {
      // already in a call with this peer (or waiting to re-dial it): do not place a second one
      existing.onCall = callback;
      existing.stream = currentStream;
      if (existing.timer) this.redialNow(existing);
      return;
    }
    if (existing) this.forget(peerId); // a first call that never got anywhere: start over
    this.gone.delete(peerId);
    const dial: Dial = {
      peerId,
      stream: currentStream,
      onCall: callback,
      connected: false,
      attempts: 0,
      since: 0,
      call: null,
      timer: null,
      attemptTimer: null,
    };
    this.dials.set(peerId, dial);
    this.dial(dial);
  }

  private dial(dial: Dial): void {
    const call = this.client.call(dial.peerId, dial.stream(), { sdpTransform: optimiseOpus });
    dial.call = call;
    this.watch(call, true, dial);
    dial.onCall(call);
    // a first call may legitimately take long on a bad network; a re-dial that finds nobody must not hang
    if (dial.connected) {
      dial.attemptTimer = setTimeout(() => this.attemptFailed(dial), REDIAL_ATTEMPT_TIMEOUT_MS);
    }
  }

  /** The call of this dial ended without ever connecting (or a re-dial found nobody): plan the next one. */
  private attemptFailed(dial: Dial): void {
    if (dial.attemptTimer) clearTimeout(dial.attemptTimer);
    dial.attemptTimer = null;
    const call = dial.call;
    if (call && call.peerConnection && isUp(call.peerConnection)) return; // it did connect after all
    if (call) {
      call.close(); // PeerJS stays silent about calls nobody answered, hence the explicit release
      this.tracked.get(call.connectionId)?.release();
    }
    this.dropped(dial);
  }

  /** Something took the call down: bring it back, unless nobody wants it (we left, or they said goodbye). */
  private dropped(dial: Dial): void {
    if (dial.attemptTimer) clearTimeout(dial.attemptTimer);
    dial.attemptTimer = null;
    if (this.destroyed || this.gone.has(dial.peerId) || !dial.connected) {
      this.dials.delete(dial.peerId);
      return;
    }
    this.planRedial(dial, true);
  }

  private planRedial(dial: Dial, countAttempt: boolean): void {
    if (dial.timer) return; // one is already waiting
    if (!dial.since) dial.since = Date.now();
    if (Date.now() - dial.since > REDIAL_GIVE_UP_MS) {
      this.dials.delete(dial.peerId);
      this.giveUpHandler?.(dial.peerId);
      return;
    }
    const base = countAttempt
      ? (REDIAL_DELAYS_MS[Math.min(dial.attempts++, REDIAL_DELAYS_MS.length - 1)] ?? 30_000)
      : 1_000;
    const delay = Math.round(base * (0.8 + Math.random() * 0.4)); // spread out, so a whole meeting does not redial in lockstep
    dial.timer = setTimeout(() => {
      dial.timer = null;
      this.redialNow(dial);
    }, delay);
  }

  private redialNow(dial: Dial): void {
    if (dial.timer) clearTimeout(dial.timer);
    dial.timer = null;
    if (this.destroyed || this.gone.has(dial.peerId)) {
      this.dials.delete(dial.peerId);
      return;
    }
    if (!this.client.open) {
      // the signalling link is down too and is being re-established: look again shortly
      this.planRedial(dial, false);
      return;
    }
    this.dial(dial);
  }

  /** The participant said goodbye (or was removed): stop trying to reach them. */
  forget(peerId: string): void {
    this.gone.add(peerId);
    const dial = this.dials.get(peerId);
    if (!dial) return;
    if (dial.timer) clearTimeout(dial.timer);
    if (dial.attemptTimer) clearTimeout(dial.attemptTimer);
    this.dials.delete(peerId);
  }

  /** Called when someone could not be reached for good (see REDIAL_GIVE_UP_MS). */
  onRedialGiveUp(callback: (peerId: string) => void): void {
    this.giveUpHandler = callback;
  }

  onReceiveCall(callback: (call: MediaConnection) => void): void {
    this.client.on('call', (call) => callback(call));
  }

  answerCall(call: MediaConnection, localStream: MediaStream): void {
    // A participant who calls us again has lost the earlier call, even if our side has not noticed yet
    for (const stale of [...this.tracked.values()]) {
      if (stale.originator || stale.call === call || stale.call.peer !== call.peer) continue;
      stale.call.close();
      stale.release();
    }
    this.knownPeers.add(call.peer);
    call.answer(localStream, { sdpTransform: optimiseOpus });
    this.watch(call, false);
  }

  /** Adapts the call to the network (bitrate), revives it after drops (ICE restart), re-dials it when it is lost. */
  private watch(call: MediaConnection, originator: boolean, dial?: Dial): void {
    const connection = call.peerConnection;
    if (!connection) return;
    this.connections.add(connection);
    iceRestart.register(call.peer, call.connectionId, connection, originator);
    networkMonitor.attach(connection, {
      originator,
      restart: () => iceRestart.restart(call.peer, call.connectionId),
      onDead: () => call.close(),
    });

    const onState = () => {
      if (!isUp(connection)) return;
      this.knownPeers.add(call.peer); // from now on this peer is somebody we know, not a mistyped meeting id
      if (!dial || dial.call !== call) return;
      dial.connected = true; // a drop of this call is now re-dialed
      dial.attempts = 0;
      dial.since = 0;
      if (dial.attemptTimer) clearTimeout(dial.attemptTimer);
      dial.attemptTimer = null;
    };
    connection.addEventListener('iceconnectionstatechange', onState);

    const entry: Tracked = {
      call,
      originator,
      ended: [],
      release: () => {
        if (this.tracked.get(call.connectionId) !== entry) return;
        this.tracked.delete(call.connectionId);
        connection.removeEventListener('iceconnectionstatechange', onState);
        this.connections.delete(connection);
        networkMonitor.detach(connection);
        iceRestart.unregister(call.peer, call.connectionId);
        for (const callback of entry.ended) callback();
        if (dial && dial.call === call) this.dropped(dial);
      },
    };
    this.tracked.set(call.connectionId, entry);
    call.on('close', entry.release);
  }

  /** Runs `callback` once when the call is over: closed by either side, failed, or given up on. */
  onCallEnded(call: MediaConnection, callback: () => void): void {
    const entry = this.tracked.get(call.connectionId);
    if (entry) entry.ended.push(callback);
    else call.on('close', callback);
  }

  /** True while at least one call of this meeting is up (a failed join has none). */
  private hasLiveCall(): boolean {
    for (const connection of this.connections) {
      if (connection.iceConnectionState === 'connected' || connection.iceConnectionState === 'completed') return true;
    }
    return false;
  }

  onCalling(
    call: MediaConnection,
    callback: (remoteConnectionId: string, remoteStream: MediaStream) => void,
  ): void {
    call.on('stream', (remoteStream) => {
      const remoteConnectionId = call.peer;
      callback(remoteConnectionId, remoteStream);
    });
  }

  disconnect(): void {
    this.destroyed = true;
    this.clearTimers();
    for (const dial of this.dials.values()) {
      if (dial.timer) clearTimeout(dial.timer);
      if (dial.attemptTimer) clearTimeout(dial.attemptTimer);
    }
    this.dials.clear();
    networkMonitor.detachAll();
    this.client.destroy();
  }

  onDisconnect(callback: () => void): void {
    this.client.on('close', () => callback());
  }
}
