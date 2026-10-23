import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.ts';

describe('loadEnv', () => {
  it('treats empty values (KEY= in a .env file) as not set', () => {
    const env = loadEnv({
      AUTH_SECRET: '',
      TURN_SECRET: '',
      TURN_URLS: '',
      BASE_URL: '',
      WEB_APP_HOST: '',
      PORT: '',
    });
    expect(env.PORT).toBe(8080);
    expect(env.TURN_SECRET).toBeUndefined();
    expect(env.TURN_URLS).toEqual([]);
    expect(env.authSecret.length).toBeGreaterThanOrEqual(32); // generated for this process
  });

  it('refuses to start in production without a real AUTH_SECRET', () => {
    expect(() => loadEnv({ NODE_ENV: 'production', AUTH_SECRET: '' })).toThrow(
      /AUTH_SECRET/,
    );
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(/AUTH_SECRET/);
    expect(() =>
      loadEnv({ NODE_ENV: 'production', AUTH_SECRET: 'too-short' }),
    ).toThrow(/at least 32/);
  });

  it('allows exactly the configured origins, and the dev ones only outside production', () => {
    const production = loadEnv({
      NODE_ENV: 'production',
      AUTH_SECRET: 'x'.repeat(32),
      WEB_APP_HOST: 'chat.example.com',
      ALLOWED_ORIGINS: 'https://other.example.com, ',
    });
    expect(production.allowedOrigins.has('https://chat.example.com')).toBe(
      true,
    );
    expect(production.allowedOrigins.has('https://other.example.com')).toBe(
      true,
    );
    expect(production.allowedOrigins.has('capacitor://localhost')).toBe(true);
    expect(production.allowedOrigins.has('http://chat.example.com')).toBe(
      false,
    );
    expect(production.allowedOrigins.has('https://localhost:3000')).toBe(false);

    expect(loadEnv({}).allowedOrigins.has('https://localhost:3000')).toBe(true);
  });

  it('accepts WEB_APP_HOST with or without a scheme', () => {
    const env = loadEnv({ WEB_APP_HOST: 'http://localhost:3010/' });
    expect(env.allowedOrigins.has('http://localhost:3010')).toBe(true);
    expect(env.allowedOrigins.has('https://localhost:3010')).toBe(true);
  });

  it('rejects malformed values with a readable message', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(/PORT/);
    expect(() => loadEnv({ TURN_SECRET: 'short' })).toThrow(/TURN_SECRET/);
  });
});
