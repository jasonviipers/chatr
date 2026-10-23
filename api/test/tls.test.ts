import { describe, expect, it } from 'vitest';
import { decideTls } from '../src/config/tls.ts';

const files = {
  TLS_KEY_PATH: './ssl/key.pem',
  TLS_CERT_PATH: './ssl/cert.pem',
};
const present = () => true;
const missing = () => false;

describe('decideTls', () => {
  it('serves plain HTTP in development, even when a certificate is lying around', () => {
    const decision = decideTls(
      { TLS: 'auto', NODE_ENV: 'development', ...files },
      present,
    );
    expect(decision.useTls).toBe(false);
    expect(decision.note).toMatch(/development/);
    expect(
      decideTls({ TLS: 'auto', NODE_ENV: 'test', ...files }, present).useTls,
    ).toBe(false);
  });

  it('serves HTTPS in production when the certificate exists', () => {
    expect(
      decideTls({ TLS: 'auto', NODE_ENV: 'production', ...files }, present)
        .useTls,
    ).toBe(true);
  });

  it('serves plain HTTP in production without a certificate (a proxy terminates TLS)', () => {
    const decision = decideTls(
      { TLS: 'auto', NODE_ENV: 'production', ...files },
      missing,
    );
    expect(decision.useTls).toBe(false);
    expect(decision.note).toMatch(/TLS-terminating proxy/);
  });

  it('TLS=off is always plain HTTP, TLS=on is always HTTPS', () => {
    expect(
      decideTls({ TLS: 'off', NODE_ENV: 'production', ...files }, present)
        .useTls,
    ).toBe(false);
    expect(
      decideTls({ TLS: 'on', NODE_ENV: 'development', ...files }, present)
        .useTls,
    ).toBe(true);
  });

  it('TLS=on refuses to start without the files instead of silently falling back to HTTP', () => {
    expect(() =>
      decideTls({ TLS: 'on', NODE_ENV: 'development', ...files }, missing),
    ).toThrow(/TLS=on needs/);
  });
});
