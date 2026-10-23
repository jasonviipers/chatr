import { iceServersUrl } from '../config';

/** Used until (or unless) the API answers: public STUN only, so direct connections still work. */
const FALLBACK: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302'] }];

interface IceResponse {
  iceServers: RTCIceServer[];
  ttl: number;
}

/**
 * Fetches the STUN/TURN servers from the API. TURN is what keeps a call alive when two people cannot
 * reach each other directly (mobile networks, strict NATs, office firewalls). The credentials expire, so
 * they are refreshed before that happens; a failed refresh keeps the last good servers and retries soon.
 */
export default class IceService {
  private static servers: RTCIceServer[] = FALLBACK;
  private static timer: ReturnType<typeof setTimeout> | null = null;
  private static started = false;

  /** Synchronous on purpose: a call starts with whatever is known right now. */
  static current(): RTCIceServer[] {
    return IceService.servers;
  }

  static start(): void {
    if (IceService.started) return;
    IceService.started = true;
    void IceService.refresh();
  }

  static async refresh(): Promise<void> {
    let nextInMs = 30_000;
    try {
      const response = await fetch(iceServersUrl, { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as IceResponse;
      if (Array.isArray(body.iceServers) && body.iceServers.length > 0) {
        IceService.servers = body.iceServers;
        nextInMs = Math.max(60_000, body.ttl * 800); // refresh at 80% of the credential lifetime
      }
    } catch {
      // offline or API down: keep what we have
    }
    if (IceService.timer) clearTimeout(IceService.timer);
    IceService.timer = setTimeout(() => void IceService.refresh(), nextInMs);
  }
}
