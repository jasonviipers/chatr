import { exposeForTests } from '../devHooks';
import { PROFILES, QualityController, summarizeStats } from './QualityController';
import type { QualityLevel, QualityProfile } from './QualityController';

const SAMPLE_INTERVAL_MS = 2_000;
/** The most a camera picture may use per call. */
const CAMERA_MAX_BITRATE = 600_000;
/** When a call drops, wait this long for the browser to heal it by itself before forcing an ICE restart. */
const DISCONNECTED_GRACE_MS = 3_000;
/** Delays before each further restart attempt if the call still has not come back. */
const RESTART_RETRY_MS = [4_000, 10_000, 20_000, 40_000];
/**
 * A call that has been down this long (every restart attempt included, the last one starts ~77 s in) is
 * given up on. Browsers often never report `failed` themselves, which would leave a frozen picture on screen.
 */
const DEAD_AFTER_MS = 90_000;

/** Adjustable so the browser tests do not have to wait a minute and a half. */
export const timing = { deadAfterMs: DEAD_AFTER_MS };
exposeForTests('networkTiming', timing);

interface Entry {
  pc: RTCPeerConnection;
  controller: QualityController;
  originator: boolean;
  restart: (() => Promise<void> | void) | undefined;
  onLevel: ((level: QualityLevel) => void) | undefined;
  onDead: (() => void) | undefined;
  sampleTimer: ReturnType<typeof setInterval>;
  restartTimer: ReturnType<typeof setTimeout> | null;
  deadTimer: ReturnType<typeof setTimeout> | null;
  restartAttempts: number;
  appliedKey: string;
  stopIceListener: () => void;
}

export interface AttachOptions {
  /** Only the side that placed the call restarts ICE, so both sides never renegotiate at once. */
  originator: boolean;
  /** How to renegotiate the network path of this call (see IceRestart). Falls back to restartIce(). */
  restart?: () => Promise<void> | void;
  onLevel?: (level: QualityLevel) => void;
  /** The call stayed down for good (either side): end it so the participant does not linger as a frozen picture. */
  onDead?: () => void;
}

/** Pushes the quality profile onto the senders of a connection. */
export async function applyProfile(pc: RTCPeerConnection, profile: QualityProfile): Promise<void> {
  for (const sender of pc.getSenders()) {
    const track = sender.track;
    if (!track) continue;
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) parameters.encodings = [{}];
      const encoding = parameters.encodings[0];
      if (!encoding) continue;

      if (track.kind === 'audio') {
        encoding.maxBitrate = profile.audioMaxBitrate;
      } else if (track.kind === 'video') {
        encoding.active = profile.screenActive;
        if (profile.screenActive) {
          // a camera (contentHint 'motion') needs far less than a shared screen: the uplink is shared by everybody in the mesh
          encoding.maxBitrate = track.contentHint === 'motion' ? Math.min(profile.screenMaxBitrate, CAMERA_MAX_BITRATE) : profile.screenMaxBitrate;
          encoding.scaleResolutionDownBy = profile.screenScaleDown;
          encoding.maxFramerate = profile.screenMaxFps;
        }
      }
      await sender.setParameters(parameters);
    } catch {
      // not every browser accepts every field; the rest of the profile still applies
    }
  }
}

/**
 * Keeps calls usable on a bad network:
 *  - measures every call (loss, delay, jitter) and adapts audio/screen-share bitrate to it;
 *  - brings a dropped call back with ICE restarts, with growing delays between attempts.
 */
class NetworkMonitor {
  private readonly entries = new Map<RTCPeerConnection, Entry>();

  attach(pc: RTCPeerConnection, options: AttachOptions): void {
    if (this.entries.has(pc)) return;

    const entry: Entry = {
      pc,
      controller: new QualityController(),
      originator: options.originator,
      restart: options.restart,
      onLevel: options.onLevel,
      onDead: options.onDead,
      sampleTimer: setInterval(() => void this.sample(entry), SAMPLE_INTERVAL_MS),
      restartTimer: null,
      deadTimer: null,
      restartAttempts: 0,
      appliedKey: '',
      stopIceListener: () => undefined,
    };

    const onIceState = () => this.onIceState(entry);
    pc.addEventListener('iceconnectionstatechange', onIceState);
    entry.stopIceListener = () => pc.removeEventListener('iceconnectionstatechange', onIceState);

    this.entries.set(pc, entry);
  }

  detach(pc: RTCPeerConnection): void {
    const entry = this.entries.get(pc);
    if (!entry) return;
    clearInterval(entry.sampleTimer);
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    if (entry.deadTimer) clearTimeout(entry.deadTimer);
    entry.stopIceListener();
    this.entries.delete(pc);
  }

  detachAll(): void {
    for (const pc of [...this.entries.keys()]) this.detach(pc);
  }

  private async sample(entry: Entry): Promise<void> {
    const { pc } = entry;
    if (pc.connectionState === 'closed' || pc.signalingState === 'closed') return this.detach(pc);

    let sample;
    try {
      sample = summarizeStats((await pc.getStats()).values());
    } catch {
      return;
    }
    if (!sample) return;

    const { level, changed } = entry.controller.push(sample);
    // new senders (screen sharing started, track replaced) also need the profile
    const key = `${level}|${pc
      .getSenders()
      .map((sender) => sender.track?.id ?? '-')
      .join(',')}`;
    if (changed || key !== entry.appliedKey) {
      entry.appliedKey = key;
      await applyProfile(pc, PROFILES[level]);
    }
    if (changed) entry.onLevel?.(level);
  }

  private onIceState(entry: Entry): void {
    const state = entry.pc.iceConnectionState;
    if (state === 'connected' || state === 'completed') {
      entry.restartAttempts = 0;
      if (entry.restartTimer) clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
      if (entry.deadTimer) clearTimeout(entry.deadTimer);
      entry.deadTimer = null;
      return;
    }
    if ((state === 'disconnected' || state === 'failed') && !entry.deadTimer && entry.onDead) {
      entry.deadTimer = setTimeout(() => {
        entry.deadTimer = null;
        const now = entry.pc.iceConnectionState;
        if (now === 'connected' || now === 'completed' || now === 'closed') return;
        entry.onDead?.();
      }, timing.deadAfterMs);
    }
    if (!entry.originator) return;
    if (state === 'failed') this.scheduleRestart(entry, 0);
    else if (state === 'disconnected') this.scheduleRestart(entry, DISCONNECTED_GRACE_MS);
  }

  private scheduleRestart(entry: Entry, delayMs: number): void {
    if (entry.restartTimer) return; // one pending attempt is enough
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      const state = entry.pc.iceConnectionState;
      if (state === 'connected' || state === 'completed' || state === 'closed') return;

      const attempt = entry.restartAttempts++;
      if (attempt > RESTART_RETRY_MS.length) return; // give up; the app decides what to tell the user
      try {
        if (entry.restart) void Promise.resolve(entry.restart()).catch(() => undefined);
        else entry.pc.restartIce();
      } catch {
        return;
      }
      // if the call is still down after this attempt, try again a bit later
      this.scheduleRestart(entry, RESTART_RETRY_MS[Math.min(attempt, RESTART_RETRY_MS.length - 1)] ?? 40_000);
    }, delayMs);
  }
}

export const networkMonitor = new NetworkMonitor();
