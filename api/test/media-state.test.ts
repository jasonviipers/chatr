import { describe, expect, it } from 'vitest';
import { buildMediaStatePayload } from '../src/realtime/media-state.ts';

describe('buildMediaStatePayload', () => {
  it('takes the two switches from the client and the identity from the server', () => {
    expect(
      buildMediaStatePayload('peerAAA123', {
        video: true,
        audio: false,
        from: 'forged',
      }),
    ).toEqual({ from: 'peerAAA123', video: true, audio: false });
  });

  it('refuses unidentified senders', () => {
    expect(
      buildMediaStatePayload(null, { video: true, audio: true }),
    ).toBeNull();
  });

  it('refuses anything that is not exactly two booleans', () => {
    for (const data of [
      null,
      undefined,
      'on',
      {},
      { video: true },
      { audio: true },
      { video: 1, audio: 0 },
      { video: 'true', audio: 'false' },
    ])
      expect(buildMediaStatePayload('p', data)).toBeNull();
  });
});
