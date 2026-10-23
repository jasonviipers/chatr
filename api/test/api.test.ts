import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { LEGACY_MD5_PREFIX, legacyMd5Hash } from '../src/auth/auth.ts';
import { account, user } from '../src/db/schema.ts';
import { buildIceServers } from '../src/routes/ice.ts';
import {
  ADMIN,
  HOST,
  ORIGIN,
  call,
  createTestApp,
  installAdmin,
} from './helpers.ts';
import { createHmac } from 'node:crypto';

describe('install flow', () => {
  it('reports nothing installed, installs once, then closes the door', async () => {
    const { app } = createTestApp();
    expect((await call(app, 'GET', '/admin')).json).toBeNull();

    const created = await call(app, 'POST', '/admin', {
      json: { ...ADMIN, confirmPassword: ADMIN.password },
    });
    expect(created.status).toBe(201);
    expect(created.json).toEqual({ created: true });

    expect((await call(app, 'GET', '/admin')).json).toEqual({
      installed: true,
    });

    // The old API let anyone create more admins at any time
    const second = await call(app, 'POST', '/admin', {
      json: {
        username: 'evil1',
        password: 'secret-pass-2',
        confirmPassword: 'secret-pass-2',
      },
    });
    expect(second.status).toBe(403);
  });

  it('validates input with the same style of messages as before', async () => {
    const { app } = createTestApp();
    const post = (json: unknown) => call(app, 'POST', '/admin', { json });

    expect((await call(app, 'POST', '/admin')).json).toEqual({
      message: 'Username is required',
    });
    expect(
      (
        await post({
          username: 'ab',
          password: 'secret-pass-1',
          confirmPassword: 'secret-pass-1',
        })
      ).json,
    ).toEqual({
      message: 'Username length must be at least 3 characters long',
    });
    expect(
      (
        await post({
          username: 'bad name!',
          password: 'secret-pass-1',
          confirmPassword: 'secret-pass-1',
        })
      ).json,
    ).toEqual({
      message: 'Username must only contain alpha-numeric characters',
    });
    expect(
      (
        await post({
          username: 'admin1',
          password: 'short',
          confirmPassword: 'short',
        })
      ).json,
    ).toEqual({
      message: 'Password length must be at least 8 characters long',
    });
    const mismatch = await post({
      username: 'admin1',
      password: 'secret-pass-1',
      confirmPassword: 'other',
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.json).toEqual({
      message: 'Confirm password must be password',
    });
  });
});

describe('authentication', () => {
  it('signs in, authenticates the token and enforces roles', async () => {
    const { app } = createTestApp();
    const adminToken = await installAdmin(app);

    expect(
      (await call(app, 'GET', '/admin/auth', { token: adminToken })).json,
    ).toEqual({ authenticated: true });
    expect((await call(app, 'GET', '/admin/auth')).status).toBe(401);
    expect(
      (await call(app, 'GET', '/admin/auth', { token: 'garbage' })).status,
    ).toBe(401);

    // an admin session is not a host session
    expect(
      (await call(app, 'GET', '/host/auth', { token: adminToken })).status,
    ).toBe(403);
  });

  it('returns the same answer for a wrong password and an unknown user', async () => {
    const { app } = createTestApp();
    await installAdmin(app);
    const wrong = await call(app, 'POST', '/admin/signIn', {
      json: { username: 'admin1', password: 'not-the-password' },
    });
    const unknown = await call(app, 'POST', '/admin/signIn', {
      json: { username: 'nobody1', password: 'not-the-password' },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json).toEqual(unknown.json);
  });

  it('locks an account after repeated failures, even for the right password', async () => {
    const { app } = createTestApp();
    await installAdmin(app);
    for (let attempt = 0; attempt < 8; attempt++) {
      expect(
        (
          await call(app, 'POST', '/admin/signIn', {
            json: { username: 'admin1', password: 'wrong-password' },
          })
        ).status,
      ).toBe(401);
    }
    const locked = await call(app, 'POST', '/admin/signIn', { json: ADMIN });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('does not expose Better Auth sign-in directly (it would bypass lockout and role checks)', async () => {
    const { app } = createTestApp();
    await installAdmin(app);
    const direct = await call(app, 'POST', '/api/auth/sign-in/username', {
      json: ADMIN,
    });
    expect(direct.status).toBe(404);
  });

  it('serves the Better Auth session endpoint for bearer tokens', async () => {
    const { app } = createTestApp();
    const token = await installAdmin(app);
    const session = await call(app, 'GET', '/api/auth/get-session', { token });
    expect(session.status).toBe(200);
    expect((session.json as { user: { username: string } }).user.username).toBe(
      'admin1',
    );
  });

  it('verifies legacy md5 passwords and upgrades them to scrypt on first login', async () => {
    const { app, db } = createTestApp();
    const adminToken = await installAdmin(app);
    await call(app, 'POST', '/host', { token: adminToken, json: HOST });

    const row = db.select().from(user).where(eq(user.username, 'host1')).get();
    expect(row).toBeDefined();
    db.update(account)
      .set({ password: legacyMd5Hash(HOST.password) })
      .where(eq(account.userId, row!.id))
      .run();

    expect(
      (
        await call(app, 'POST', '/host/signIn', {
          json: { ...HOST, password: 'wrong-password' },
        })
      ).status,
    ).toBe(401);
    const ok = await call(app, 'POST', '/host/signIn', {
      json: { username: HOST.username, password: HOST.password },
    });
    expect(ok.status).toBe(200);

    const upgraded = db
      .select()
      .from(account)
      .where(eq(account.userId, row!.id))
      .get();
    expect(upgraded?.password).toBeTruthy();
    expect(upgraded?.password?.startsWith(LEGACY_MD5_PREFIX)).toBe(false);

    // and it still works with the new hash
    expect(
      (
        await call(app, 'POST', '/host/signIn', {
          json: { username: HOST.username, password: HOST.password },
        })
      ).status,
    ).toBe(200);
  });
});

describe('hosts', () => {
  it('lets an admin manage hosts and never leaks secrets', async () => {
    const { app } = createTestApp();
    const adminToken = await installAdmin(app);

    expect((await call(app, 'POST', '/host', { json: HOST })).status).toBe(401);
    const created = await call(app, 'POST', '/host', {
      token: adminToken,
      json: HOST,
    });
    expect(created.status).toBe(201);
    expect(Object.keys(created.json as object).sort()).toEqual([
      'createdAt',
      'id',
      'lastMeetingAt',
      'name',
      'updatedAt',
      'username',
    ]);
    expect(created.text).not.toMatch(/password|accessToken|md5|scrypt/i);

    expect(
      (await call(app, 'POST', '/host', { token: adminToken, json: HOST }))
        .status,
    ).toBe(409);

    const list = await call(app, 'GET', '/hosts', { token: adminToken });
    expect((list.json as unknown[]).length).toBe(1);
    expect(list.text).not.toMatch(/password|accessToken/i);
  });

  it('keeps hosts out of admin routes and limits them to their own record', async () => {
    const { app } = createTestApp();
    const adminToken = await installAdmin(app);
    const host = (
      await call(app, 'POST', '/host', { token: adminToken, json: HOST })
    ).json as { id: number };
    const other = (
      await call(app, 'POST', '/host', {
        token: adminToken,
        json: { name: 'Host Two', username: 'host2', password: 'host-pass-2' },
      })
    ).json as { id: number };

    const signedIn = await call(app, 'POST', '/host/signIn', {
      json: { username: HOST.username, password: HOST.password },
    });
    const token = (signedIn.json as { accessToken: string }).accessToken;
    expect((await call(app, 'GET', '/host/auth', { token })).status).toBe(200);
    expect((await call(app, 'GET', '/hosts', { token })).status).toBe(403);
    expect(
      (await call(app, 'DELETE', '/host', { token, json: { id: other.id } }))
        .status,
    ).toBe(403);

    expect(
      (
        await call(app, 'PATCH', '/host/lastMeetingAt', {
          token,
          json: { id: host.id },
        })
      ).json,
    ).toEqual({ updated: true });
    // the old API let any host stamp any other host
    expect(
      (
        await call(app, 'PATCH', '/host/lastMeetingAt', {
          token,
          json: { id: other.id },
        })
      ).status,
    ).toBe(403);

    const hosts = (await call(app, 'GET', '/hosts', { token: adminToken }))
      .json as { id: number; lastMeetingAt: string | null }[];
    expect(hosts.find((h) => h.id === host.id)?.lastMeetingAt).not.toBeNull();
    expect(hosts.find((h) => h.id === other.id)?.lastMeetingAt).toBeNull();
  });

  it('deletes a host together with their sessions, and never deletes admins', async () => {
    const { app } = createTestApp();
    const adminToken = await installAdmin(app);
    const host = (
      await call(app, 'POST', '/host', { token: adminToken, json: HOST })
    ).json as { id: number };
    const token = (
      (
        await call(app, 'POST', '/host/signIn', {
          json: { username: HOST.username, password: HOST.password },
        })
      ).json as { accessToken: string }
    ).accessToken;

    expect(
      (
        await call(app, 'DELETE', '/host', {
          token: adminToken,
          json: { id: host.id },
        })
      ).json,
    ).toEqual({ deleted: true });
    expect((await call(app, 'GET', '/host/auth', { token })).status).toBe(401);
    expect(
      (
        await call(app, 'DELETE', '/host', {
          token: adminToken,
          json: { id: host.id },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(app, 'DELETE', '/host', {
          token: adminToken,
          json: { id: 1 },
        })
      ).status,
    ).toBe(404); // id 1 is the admin
    expect(
      (await call(app, 'DELETE', '/host', { token: adminToken, json: {} }))
        .status,
    ).toBe(422);
  });
});

describe('privacy policy', () => {
  it('stores sanitised HTML only and only for admins', async () => {
    const { app } = createTestApp();
    const adminToken = await installAdmin(app);
    const hostToken = await (async () => {
      await call(app, 'POST', '/host', { token: adminToken, json: HOST });
      return (
        (
          await call(app, 'POST', '/host/signIn', {
            json: { username: HOST.username, password: HOST.password },
          })
        ).json as { accessToken: string }
      ).accessToken;
    })();

    expect((await call(app, 'GET', '/privacy')).json).toBeNull();
    expect(
      (await call(app, 'POST', '/privacy', { json: { body: '<p>x</p>' } }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(app, 'POST', '/privacy', {
          token: hostToken,
          json: { body: '<p>x</p>' },
        })
      ).status,
    ).toBe(403);

    const dirty =
      '<h1>Policy</h1><p class="ql-align-center" onclick="steal()">We value <strong>privacy</strong>.</p><script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://ok.example">ok</a><img src=x onerror=alert(1)>';
    expect(
      (
        await call(app, 'POST', '/privacy', {
          token: adminToken,
          json: { body: dirty },
        })
      ).json,
    ).toEqual({ updated: true });
    const stored = (
      (await call(app, 'GET', '/privacy')).json as { body: string }
    ).body;
    expect(stored).toContain('<h1>Policy</h1>');
    expect(stored).toContain('ql-align-center');
    expect(stored).toContain('<strong>privacy</strong>');
    expect(stored).toContain('href="https://ok.example"');
    expect(stored).not.toMatch(/script|onclick|onerror|javascript:|<img/i);

    // second write updates the single row
    await call(app, 'POST', '/privacy', {
      token: adminToken,
      json: { body: '<p>v2</p>' },
    });
    expect(
      ((await call(app, 'GET', '/privacy')).json as { body: string }).body,
    ).toBe('<p>v2</p>');

    expect(
      (
        await call(app, 'POST', '/privacy', {
          token: adminToken,
          json: { body: 'x'.repeat(50_001) },
        })
      ).status,
    ).toBe(422);
  });
});

describe('http hardening', () => {
  it('sends security headers and only allows listed origins', async () => {
    const { app } = createTestApp();
    const allowed = await call(app, 'GET', '/privacy', {
      headers: { origin: ORIGIN },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(allowed.headers.get('x-content-type-options')).toBe('nosniff');
    // development is plain HTTP and must not make browsers pin "localhost" to HTTPS; production is HTTPS only
    expect(allowed.headers.get('strict-transport-security')).toBeNull();
    const production = createTestApp({ NODE_ENV: 'production' });
    const secured = await call(production.app, 'GET', '/privacy', {
      headers: { origin: ORIGIN },
    });
    expect(secured.headers.get('strict-transport-security')).toMatch(
      /max-age=63072000/,
    );
    expect(allowed.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    );

    const foreign = await call(app, 'GET', '/privacy', {
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await app.request('/host', {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(
      preflight.headers.get('access-control-allow-headers')?.toLowerCase(),
    ).toContain('authorization');
  });

  it('answers errors as JSON without leaking details', async () => {
    const { app } = createTestApp();
    const missing = await call(app, 'GET', '/definitely-not-here');
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ message: 'Not found' });

    const malformed = await call(app, 'POST', '/admin', { raw: '{bad json' });
    expect(malformed.status).toBe(400);
    expect(malformed.text).not.toMatch(/at .*\.(ts|js):\d+/); // no stack traces

    const big = await call(app, 'POST', '/privacy', {
      raw: JSON.stringify({ body: 'x'.repeat(200_000) }),
    });
    expect(big.status).toBe(413);
  });
});

describe('ICE servers', () => {
  it('hands out STUN only by default and time-limited TURN credentials when configured', async () => {
    const plain = createTestApp();
    const stun = await call(plain.app, 'GET', '/ice-servers');
    expect(stun.status).toBe(200);
    expect(
      (stun.json as { iceServers: { urls: string[] }[] }).iceServers,
    ).toHaveLength(1);

    const turn = createTestApp({
      TURN_URLS: 'turn:turn.example.test:3478,turns:turn.example.test:5349',
      TURN_SECRET: 'a-turn-shared-secret-1234',
      TURN_TTL_SECONDS: '600',
    });
    const result = (await call(turn.app, 'GET', '/ice-servers')).json as {
      iceServers: { urls: string[]; username?: string; credential?: string }[];
      ttl: number;
    };
    const relay = result.iceServers[1]!;
    expect(relay.urls).toContain('turn:turn.example.test:3478');
    const expectedCredential = createHmac('sha1', 'a-turn-shared-secret-1234')
      .update(relay.username!)
      .digest('base64');
    expect(relay.credential).toBe(expectedCredential);
    expect(Number(relay.username)).toBeGreaterThan(Date.now() / 1000);
  });

  it('computes credentials from the clock it is given', () => {
    const { iceServers } = buildIceServers(
      {
        STUN_URLS: ['stun:s'],
        TURN_URLS: ['turn:t'],
        TURN_SECRET: 'x'.repeat(16),
        TURN_TTL_SECONDS: 3600,
      },
      1_000_000,
    );
    expect(iceServers[1]?.username).toBe(String(1000 + 3600));
  });
});

describe('peer id endpoint', () => {
  it('issues unique ids and refuses to list peers', async () => {
    const { app } = createTestApp();
    const first = await call(app, 'GET', '/peer/peerjs/id');
    const second = await call(app, 'GET', '/peer/peerjs/id');
    expect(first.text).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(first.text).not.toBe(second.text);
    expect((await call(app, 'GET', '/peer/peerjs/peers')).status).toBe(401);
  });
});
