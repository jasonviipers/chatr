import type { IceServer } from '../routes/ice.ts';

export interface IssuedIceServers {
  iceServers: IceServer[];
  /** Seconds the credentials stay valid from now. */
  ttl: number;
}

export interface CloudflareTurnOptions {
  keyId: string;
  apiToken: string;
  /** Without a trailing slash. Only changed in tests. */
  baseUrl: string;
  /** Lifetime asked for when credentials are created (Cloudflare allows up to 48 hours). */
  ttlSeconds: number;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Where problems are reported (never contains the API token). */
  log?: (line: string) => void;
}

/** A set that is about to expire is not worth handing out. */
const MIN_USEFUL_MS = 10 * 60_000;
const WARN_EVERY_MS = 60_000;

/**
 * Relay (TURN) credentials from Cloudflare Realtime TURN: https://developers.cloudflare.com/realtime/turn/
 *
 * One authenticated request creates a username and credential that expire by themselves, so the TURN key
 * never leaves this server. The result is shared by everybody who asks while more than half of its
 * lifetime is left (so a set that is handed out always has at least half of the lifetime in front of it),
 * and a Cloudflare outage does not break the app: the last set is served for as long as it is useful,
 * and after that the clients simply get STUN only.
 */
export class CloudflareTurn {
  private readonly options: CloudflareTurnOptions;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private cached: { servers: IceServer[]; validUntil: number } | null = null;
  private inflight: Promise<boolean> | null = null;
  private lastWarning: number | null = null;

  constructor(options: CloudflareTurnOptions) {
    this.options = options;
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private get lifetimeMs() {
    return this.options.ttlSeconds * 1000;
  }

  async get(): Promise<IssuedIceServers | null> {
    const half = this.lifetimeMs / 2;
    if (this.cached && this.cached.validUntil - this.now() > half)
      return this.describe(this.cached);

    this.inflight ??= this.issue().finally(() => {
      this.inflight = null;
    });
    await this.inflight;

    if (this.cached && this.cached.validUntil - this.now() > MIN_USEFUL_MS)
      return this.describe(this.cached);
    return null;
  }

  private describe(entry: { servers: IceServer[]; validUntil: number }) {
    return {
      iceServers: entry.servers,
      ttl: Math.max(1, Math.floor((entry.validUntil - this.now()) / 1000)),
    };
  }

  /** Asks Cloudflare for a new set. Resolves true when it worked; failures are reported and swallowed. */
  private async issue(): Promise<boolean> {
    const {
      keyId,
      apiToken,
      baseUrl,
      ttlSeconds,
      timeoutMs = 4000,
    } = this.options;
    const requestedAt = this.now();
    try {
      const response = await this.fetchFn(
        `${baseUrl}/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ttl: ttlSeconds }),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (!response.ok)
        throw new Error(`Cloudflare answered ${response.status}`);
      const servers = parseIceServers(await response.json());
      if (!servers) throw new Error('Cloudflare answered with no relay server');
      this.cached = { servers, validUntil: requestedAt + this.lifetimeMs };
      return true;
    } catch (error) {
      this.warn(
        `Cloudflare TURN credentials could not be created: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      return false;
    }
  }

  private warn(line: string) {
    const at = this.now();
    if (this.lastWarning !== null && at - this.lastWarning < WARN_EVERY_MS)
      return;
    this.lastWarning = at;
    this.options.log?.(line);
  }
}

/** Keeps only well-formed servers, and only when at least one of them is a relay with credentials. */
export function parseIceServers(body: unknown): IceServer[] | null {
  const raw =
    typeof body === 'object' && body !== null && 'iceServers' in body
      ? body.iceServers
      : null;
  // `generate-ice-servers` answers with a list; the older `generate` answers with a single server
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];

  const servers: IceServer[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { urls, username, credential } = entry as Record<string, unknown>;
    const list = (Array.isArray(urls) ? urls : [urls]).filter(
      (url): url is string =>
        typeof url === 'string' && /^(stun|turn|turns):/.test(url),
    );
    if (list.length === 0) continue;
    if (typeof username === 'string' && typeof credential === 'string')
      servers.push({ urls: list, username, credential });
    else servers.push({ urls: list });
  }
  return servers.some((server) => server.username && server.credential)
    ? servers
    : null;
}
