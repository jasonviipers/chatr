import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.ts';
import { CloudflareTurn, parseIceServers } from '../src/lib/cloudflare-turn.ts';
import { call, createTestApp } from './helpers.ts';

const RELAY = {
  urls: [
    'turn:turn.cloudflare.com:3478?transport=udp',
    'turns:turn.cloudflare.com:443?transport=tcp',
  ],
  username: 'user-from-cloudflare',
  credential: 'secret-from-cloudflare',
};
const CLOUDFLARE_ANSWER = {
  iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, RELAY],
};
const TOKEN = 'token-that-must-stay-secret';

function answer(body: unknown, status = 201) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A stand-in for fetch that records the requests it gets and answers with whatever `respond` says. */
function fakeFetch(respond: () => Response | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const result = respond();
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(result);
  }) as typeof fetch;
  return { fetchFn, calls };
}

function client(
  fetchFn: typeof fetch,
  extra: { now?: () => number; log?: (line: string) => void } = {},
) {
  return new CloudflareTurn({
    keyId: 'key-123',
    apiToken: TOKEN,
    baseUrl: 'https://cloudflare.example.test',
    ttlSeconds: 3600,
    fetch: fetchFn,
    ...extra,
  });
}

describe('Cloudflare TURN credentials', () => {
  it('asks Cloudflare for a time-limited set with the key, and returns its servers', async () => {
    const { fetchFn, calls } = fakeFetch(() => answer(CLOUDFLARE_ANSWER));
    const result = await client(fetchFn).get();

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(
      'https://cloudflare.example.test/v1/turn/keys/key-123/credentials/generate-ice-servers',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({ ttl: 3600 });
    expect(result?.iceServers).toEqual(CLOUDFLARE_ANSWER.iceServers);
    expect(result?.ttl).toBeGreaterThan(3500);
  });

  it('shares one set between clients and only asks again when less than half of its life is left', async () => {
    let now = 1_000_000;
    const { fetchFn, calls } = fakeFetch(() => answer(CLOUDFLARE_ANSWER));
    const turn = client(fetchFn, { now: () => now });

    await Promise.all([turn.get(), turn.get(), turn.get()]); // at the same moment: one request
    expect(calls).toHaveLength(1);

    now += 1_700_000; // 28 minutes of 60: still more than half
    await turn.get();
    expect(calls).toHaveLength(1);

    now += 200_000; // past half
    const renewed = await turn.get();
    expect(calls).toHaveLength(2);
    expect(renewed?.ttl).toBeGreaterThan(3500); // the new set has its full life in front of it
  });

  it('keeps serving the last set while Cloudflare is down, then stops offering a set that is nearly over', async () => {
    let now = 5_000_000;
    let up = true;
    const { fetchFn } = fakeFetch(() =>
      up ? answer(CLOUDFLARE_ANSWER) : answer({}, 503),
    );
    const lines: string[] = [];
    const turn = client(fetchFn, {
      now: () => now,
      log: (line) => lines.push(line),
    });

    await turn.get();
    up = false;
    now += 2_000_000; // past half of the life: tries again, fails
    expect((await turn.get())?.iceServers).toEqual(
      CLOUDFLARE_ANSWER.iceServers,
    );
    expect(lines).toHaveLength(1);

    now += 1_000_000; // 3,000 s of 3,600 used: ten minutes or less left
    expect(await turn.get()).toBeNull();
  });

  it('gives nothing (the app falls back to STUN) when Cloudflare never answered, and never logs the token', async () => {
    const lines: string[] = [];
    const { fetchFn } = fakeFetch(
      () => new Error(`connect ECONNREFUSED (request used ${TOKEN})`),
    );
    const turn = client(fetchFn, { log: (line) => lines.push(line) });

    expect(await turn.get()).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/could not be created/);
  });

  it('rate-limits its own warnings', async () => {
    let now = 0;
    const lines: string[] = [];
    const { fetchFn } = fakeFetch(() => answer({}, 500));
    const turn = client(fetchFn, {
      now: () => now,
      log: (line) => lines.push(line),
    });
    await turn.get();
    now += 5_000;
    await turn.get();
    expect(lines).toHaveLength(1);
    now += 60_000;
    await turn.get();
    expect(lines).toHaveLength(2);
  });
});

describe('parseIceServers', () => {
  it('accepts the list form and the older single-server form, and normalises urls', () => {
    expect(parseIceServers(CLOUDFLARE_ANSWER)).toEqual(
      CLOUDFLARE_ANSWER.iceServers,
    );
    expect(
      parseIceServers({
        iceServers: {
          urls: 'turn:turn.example:3478',
          username: 'u',
          credential: 'c',
        },
      }),
    ).toEqual([
      { urls: ['turn:turn.example:3478'], username: 'u', credential: 'c' },
    ]);
  });

  it('refuses answers that hold no usable relay', () => {
    expect(parseIceServers(null)).toBeNull();
    expect(parseIceServers({})).toBeNull();
    expect(parseIceServers({ iceServers: [] })).toBeNull();
    // STUN only
    expect(
      parseIceServers({
        iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
      }),
    ).toBeNull();
    // not a stun/turn address
    expect(
      parseIceServers({
        iceServers: [
          { urls: ['https://evil.example'], username: 'u', credential: 'c' },
        ],
      }),
    ).toBeNull();
    // no credential
    expect(
      parseIceServers({
        iceServers: [{ urls: ['turn:t:3478'], username: 'u' }],
      }),
    ).toBeNull();
  });
});

describe('settings', () => {
  it('needs the key id and the token together', () => {
    expect(() => loadEnv({ CLOUDFLARE_TURN_KEY_ID: 'abc' })).toThrow(
      /CLOUDFLARE_TURN_API_TOKEN/,
    );
    expect(() => loadEnv({ CLOUDFLARE_TURN_API_TOKEN: 'abc' })).toThrow(
      /CLOUDFLARE_TURN_KEY_ID/,
    );
    const env = loadEnv({
      CLOUDFLARE_TURN_KEY_ID: 'abc',
      CLOUDFLARE_TURN_API_TOKEN: 'def',
    });
    expect(env.CLOUDFLARE_TURN_TTL_SECONDS).toBe(86_400);
    expect(env.CLOUDFLARE_TURN_API_URL).toBe('https://rtc.live.cloudflare.com');
    expect(loadEnv({}).CLOUDFLARE_TURN_KEY_ID).toBeUndefined();
  });

  it('keeps the lifetime within what Cloudflare allows (48 hours)', () => {
    const keys = {
      CLOUDFLARE_TURN_KEY_ID: 'abc',
      CLOUDFLARE_TURN_API_TOKEN: 'def',
    };
    expect(() =>
      loadEnv({ ...keys, CLOUDFLARE_TURN_TTL_SECONDS: '200000' }),
    ).toThrow(/CLOUDFLARE_TURN_TTL_SECONDS/);
    expect(() =>
      loadEnv({ ...keys, CLOUDFLARE_TURN_TTL_SECONDS: '60' }),
    ).toThrow(/CLOUDFLARE_TURN_TTL_SECONDS/);
  });
});

type IceBody = {
  iceServers: { urls: string[]; username?: string }[];
  ttl: number;
};

describe('GET /ice-servers with Cloudflare TURN', () => {
  it('adds the relay to the STUN server, with the credentials Cloudflare issued', async () => {
    const { fetchFn } = fakeFetch(() => answer(CLOUDFLARE_ANSWER));
    const { app } = createTestApp({}, { cloudflareTurn: client(fetchFn) });
    const response = await call(app, 'GET', '/ice-servers');
    const body = response.json as IceBody;

    expect(response.status).toBe(200);
    expect(body.iceServers[0]?.urls).toEqual(['stun:stun.l.google.com:19302']); // the app's own STUN first
    expect(
      body.iceServers.some((server) => server.username === RELAY.username),
    ).toBe(true);
    expect(body.ttl).toBeGreaterThan(3500);
    expect(response.text).not.toContain(TOKEN); // the key never leaves the server
  });

  it('builds the client from the settings when none is given', async () => {
    const { app } = createTestApp({
      CLOUDFLARE_TURN_KEY_ID: 'key-123',
      CLOUDFLARE_TURN_API_TOKEN: TOKEN,
      CLOUDFLARE_TURN_API_URL: 'http://127.0.0.1:9', // nothing listens there: Cloudflare "is down"
    });
    const response = await call(app, 'GET', '/ice-servers');
    expect(response.status).toBe(200);
    expect((response.json as IceBody).iceServers).toHaveLength(1); // STUN only, no error
  });

  it('still answers with STUN only when Cloudflare is down', async () => {
    const { fetchFn } = fakeFetch(() => answer({}, 500));
    const { app } = createTestApp({}, { cloudflareTurn: client(fetchFn) });
    const response = await call(app, 'GET', '/ice-servers');
    expect(response.status).toBe(200);
    expect((response.json as IceBody).iceServers).toHaveLength(1);
  });

  it('can run next to coturn: both relays are offered and the shorter lifetime wins', async () => {
    const { fetchFn } = fakeFetch(() => answer(CLOUDFLARE_ANSWER));
    const { app } = createTestApp(
      {
        TURN_URLS: 'turn:coturn.example.test:3478',
        TURN_SECRET: 'a-turn-shared-secret-1234',
        TURN_TTL_SECONDS: '600',
      },
      { cloudflareTurn: client(fetchFn) },
    );
    const body = (await call(app, 'GET', '/ice-servers')).json as IceBody;
    const urls = body.iceServers.flatMap((server) => server.urls);
    expect(urls).toContain('turn:coturn.example.test:3478');
    expect(urls).toContain('turns:turn.cloudflare.com:443?transport=tcp');
    expect(body.ttl).toBeLessThanOrEqual(600);
  });
});
