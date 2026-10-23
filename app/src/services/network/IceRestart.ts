import { exposeForTests } from '../devHooks';
import SocketService from '../SocketService';
import { optimiseOpus } from './opus';

/**
 * Brings a call back after the network path changed or died (Wi-Fi -> mobile data, a dropped
 * connection, a NAT rebinding): the caller makes a new offer with `iceRestart: true`, the other side
 * answers, and both gather fresh candidates. The media keeps its codecs and tracks; only the network
 * path is renegotiated, so the user hears a short gap instead of the call ending.
 *
 * PeerJS cannot renegotiate an existing call, so these messages travel over the realtime gateway
 * (which survives short outages by itself: acknowledged, replayed after a reconnect).
 *
 * Ordering matters: the browser starts gathering candidates while the description is being set, i.e.
 * before the offer/answer has been sent. Those candidates are held back and sent right after it, and
 * candidates that arrive before the description they belong to are kept until it has been applied.
 */

type Message =
  | { kind: 'offer'; connectionId: string; sdp: string }
  | { kind: 'answer'; connectionId: string; sdp: string }
  | { kind: 'candidate'; connectionId: string; candidate: RTCIceCandidateInit | null };

interface Entry {
  pc: RTCPeerConnection;
  remoteId: string;
  connectionId: string;
  originator: boolean;
  /** a restart is in flight (stops a second one from overlapping) */
  busy: boolean;
  busyTimer: ReturnType<typeof setTimeout> | null;
  /** local candidates are held back until the offer/answer has gone out */
  collecting: boolean;
  queue: RTCIceCandidateInit[];
  /** after the offer/answer: forward local candidates until the connection is back */
  active: boolean;
  remoteReady: boolean;
  pending: RTCIceCandidateInit[];
  /** incoming messages are handled one at a time, in order */
  inbox: Promise<void>;
  stop: () => void;
}

/** The slice of SocketService this needs (injectable so it can be tested without a network). */
export interface SocketPort {
  subscribe(channel: string, handler: (payload: any) => void): void;
  unsubscribe(channel: string): void;
  publish(channel: string, data: unknown): void;
}

const BUSY_TIMEOUT_MS = 15_000;
const key = (remoteId: string, connectionId: string) => `${remoteId}|${connectionId}`;
const channel = (peerId: string) => `/iceRestart/${peerId}`;

export class IceRestartCoordinator {
  private readonly entries = new Map<string, Entry>();
  private readonly socket: SocketPort;
  private ownId: string | null = null;

  constructor(socket: SocketPort = SocketService) {
    this.socket = socket;
  }

  /** Start receiving renegotiation messages addressed to this tab (idempotent per peer id). */
  listen(ownId: string): void {
    if (this.ownId === ownId) return;
    if (this.ownId) this.socket.unsubscribe(channel(this.ownId));
    this.ownId = ownId;
    this.socket.subscribe(channel(ownId), (payload: { from?: string; data?: Message }) => this.receive(payload));
  }

  register(remoteId: string, connectionId: string, pc: RTCPeerConnection, originator: boolean): void {
    const entry: Entry = {
      pc,
      remoteId,
      connectionId,
      originator,
      busy: false,
      busyTimer: null,
      collecting: false,
      queue: [],
      active: false,
      remoteReady: false,
      pending: [],
      inbox: Promise.resolve(),
      stop: () => undefined,
    };

    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate) return;
      const candidate = event.candidate.toJSON();
      if (entry.collecting) entry.queue.push(candidate);
      else if (entry.active) this.send(remoteId, { kind: 'candidate', connectionId, candidate });
    };
    const onState = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        entry.active = false;
        this.finish(entry);
      }
    };
    pc.addEventListener('icecandidate', onCandidate);
    pc.addEventListener('iceconnectionstatechange', onState);
    entry.stop = () => {
      pc.removeEventListener('icecandidate', onCandidate);
      pc.removeEventListener('iceconnectionstatechange', onState);
      if (entry.busyTimer) clearTimeout(entry.busyTimer);
    };
    this.entries.set(key(remoteId, connectionId), entry);
  }

  unregister(remoteId: string, connectionId: string): void {
    const k = key(remoteId, connectionId);
    this.entries.get(k)?.stop();
    this.entries.delete(k);
  }

  /** Caller side: renegotiate the network path of this call. */
  async restart(remoteId: string, connectionId: string): Promise<void> {
    const entry = this.entries.get(key(remoteId, connectionId));
    if (!entry || !entry.originator) return; // only the caller offers, so both sides never offer at once
    if (entry.busy) return;
    this.begin(entry);

    try {
      const { pc } = entry;
      entry.remoteReady = false;
      entry.pending = [];
      entry.collecting = true;
      const offer = await pc.createOffer({ iceRestart: true });
      const sdp = offer.sdp ? optimiseOpus(offer.sdp) : offer.sdp;
      await pc.setLocalDescription({ type: 'offer', ...(sdp ? { sdp } : {}) });
      this.send(remoteId, { kind: 'offer', connectionId, sdp: pc.localDescription?.sdp ?? sdp ?? '' });
      this.release(entry);
    } catch (error) {
      entry.collecting = false;
      this.finish(entry);
      throw error;
    }
  }

  /** Renegotiate every call this tab placed (the network path probably changed). */
  async restartAll(): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      if (entry.originator) await this.restart(entry.remoteId, entry.connectionId).catch(() => undefined);
    }
  }

  private receive(payload: { from?: string; data?: Message }): void {
    const { from, data } = payload;
    if (!from || !data) return;
    const entry = this.entries.get(key(from, data.connectionId));
    if (!entry) return;
    entry.inbox = entry.inbox.then(() => this.handle(entry, from, data)).catch((error) => console.warn('ICE restart message failed', error));
  }

  private async handle(entry: Entry, from: string, data: Message): Promise<void> {
    const { pc } = entry;

    if (data.kind === 'offer') {
      if (entry.originator) return; // the caller never answers
      this.begin(entry);
      entry.remoteReady = false;
      await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      entry.remoteReady = true;
      await this.flush(entry); // candidates that arrived ahead of this offer
      const answer = await pc.createAnswer();
      const sdp = answer.sdp ? optimiseOpus(answer.sdp) : answer.sdp;
      entry.collecting = true;
      await pc.setLocalDescription({ type: 'answer', ...(sdp ? { sdp } : {}) });
      this.send(from, { kind: 'answer', connectionId: data.connectionId, sdp: pc.localDescription?.sdp ?? sdp ?? '' });
      this.release(entry);
    } else if (data.kind === 'answer') {
      if (!entry.originator) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      entry.remoteReady = true;
      await this.flush(entry);
    } else if (data.candidate) {
      if (entry.remoteReady) await pc.addIceCandidate(data.candidate).catch(() => undefined);
      else entry.pending.push(data.candidate); // belongs to an offer/answer that has not been applied yet
    }
  }

  /** The offer/answer is out: send the candidates gathered meanwhile, then keep forwarding new ones. */
  private release(entry: Entry): void {
    entry.collecting = false;
    entry.active = true;
    for (const candidate of entry.queue.splice(0)) this.send(entry.remoteId, { kind: 'candidate', connectionId: entry.connectionId, candidate });
  }

  private begin(entry: Entry): void {
    entry.busy = true;
    if (entry.busyTimer) clearTimeout(entry.busyTimer);
    entry.busyTimer = setTimeout(() => this.finish(entry), BUSY_TIMEOUT_MS);
  }

  private finish(entry: Entry): void {
    entry.busy = false;
    if (entry.busyTimer) clearTimeout(entry.busyTimer);
    entry.busyTimer = null;
  }

  private async flush(entry: Entry): Promise<void> {
    for (const candidate of entry.pending.splice(0)) await entry.pc.addIceCandidate(candidate).catch(() => undefined);
  }

  private send(remoteId: string, message: Message): void {
    this.socket.publish(channel(remoteId), message);
  }
}

export const iceRestart = new IceRestartCoordinator();

// Coming back online usually means the network path changed (Wi-Fi <-> mobile data): do not wait for ICE to time out
window.addEventListener('online', () => void iceRestart.restartAll());

exposeForTests('iceRestart', iceRestart);
