import { afterEach, describe, expect, it, vi } from 'vitest';
import MeetingStatusService from './MeetingStatusService';

const answer = (body: unknown, init?: ResponseInit) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), init)));

afterEach(() => vi.unstubAllGlobals());

describe('MeetingStatusService.isLocked', () => {
  it('asks the API about this meeting and reports a locked one', async () => {
    answer({ locked: true });
    expect(await MeetingStatusService.isLocked('hostAAAA1')).toBe(true);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/meetings\/hostAAAA1$/);
    expect(init.cache).toBe('no-store');
  });

  it('reports an open meeting as open', async () => {
    answer({ locked: false });
    expect(await MeetingStatusService.isLocked('hostAAAA1')).toBe(false);
  });

  it('never stops a join because the question could not be answered', async () => {
    answer({ error: 'busy' }, { status: 429 });
    expect(await MeetingStatusService.isLocked('hostAAAA1')).toBe(false);
    answer('not an object');
    expect(await MeetingStatusService.isLocked('hostAAAA1')).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('network down'))));
    expect(await MeetingStatusService.isLocked('hostAAAA1')).toBe(false);
  });

  it('keeps odd characters in an id from changing the address', async () => {
    answer({ locked: false });
    await MeetingStatusService.isLocked('a/b?c');
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toMatch(/\/meetings\/a%2Fb%3Fc$/);
  });
});
