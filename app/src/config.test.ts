import { describe, expect, it } from 'vitest';
import { resolveApi, resolveAppUrl } from './config';

describe('resolveAppUrl', () => {
  it('follows the environment when the host has no scheme', () => {
    expect(resolveAppUrl('localhost:3000', true)).toBe('http://localhost:3000');
    expect(resolveAppUrl('example.com', false)).toBe('https://example.com');
  });

  it('keeps a scheme that is given, and drops a trailing slash', () => {
    expect(resolveAppUrl('http://localhost:3000', true)).toBe('http://localhost:3000');
    expect(resolveAppUrl('https://example.com/', true)).toBe('https://example.com');
  });
});

describe('resolveApi', () => {
  it('talks plain http / ws in development', () => {
    const api = resolveApi('localhost:8080', true);
    expect(api.baseUrl).toBe('http://localhost:8080');
    expect(api.socketUrl).toBe('ws://localhost:8080/socket');
    expect(api.peer).toEqual({ host: 'localhost', port: 8080, path: '/peer', secure: false });
  });

  it('talks https / wss in production', () => {
    const api = resolveApi('example.com', false);
    expect(api.baseUrl).toBe('https://example.com');
    expect(api.socketUrl).toBe('wss://example.com/socket');
    expect(api.peer).toEqual({ host: 'example.com', port: 443, path: '/peer', secure: true });
  });

  it('keeps a path prefix, for an API published under /api', () => {
    const api = resolveApi('example.com/api/', false);
    expect(api.baseUrl).toBe('https://example.com/api');
    expect(api.socketUrl).toBe('wss://example.com/api/socket');
    expect(api.peer.path).toBe('/api/peer');
  });

  it('uses the standard port of the protocol when none is given', () => {
    expect(resolveApi('localhost', true).peer.port).toBe(80);
    expect(resolveApi('localhost', false).peer.port).toBe(443);
  });

  it('an explicit scheme wins over the environment', () => {
    const insecure = resolveApi('http://localhost:8080', false);
    expect(insecure.baseUrl).toBe('http://localhost:8080');
    expect(insecure.socketUrl).toBe('ws://localhost:8080/socket');
    expect(insecure.peer.secure).toBe(false);

    const secure = resolveApi('https://localhost:8080', true);
    expect(secure.baseUrl).toBe('https://localhost:8080');
    expect(secure.socketUrl).toBe('wss://localhost:8080/socket');
    expect(secure.peer.secure).toBe(true);
  });
});
