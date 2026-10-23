import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoState } from '../../pages/Meeting/Meeting.state';
import Video from './Video';

class FakeStream {
  constructor(private tracks: { kind: string; id: string }[] = []) {}
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}

const tile = (overrides: Partial<VideoState> = {}, tracks = [{ kind: 'audio', id: 'a' }, { kind: 'video', id: 'v' }]): VideoState => ({
  id: 'peer',
  stream: new FakeStream(tracks) as unknown as MediaStream,
  kind: 'media',
  raiseHand: false,
  memberRemove: false,
  active: false,
  muted: false,
  streamMuted: { video: true, audio: false },
  renderId: 'r',
  ...overrides,
});

describe('Video', () => {
  // the voice of a tile is a new MediaStream made of its audio tracks
  beforeEach(() => vi.stubGlobal('MediaStream', FakeStream));
  afterEach(() => vi.unstubAllGlobals());

  it('plays somebody else\'s voice through an audio element of its own, and only the voice', () => {
    // a video element does not start until it has a picture; a call without a camera has none
    const { container } = render(<Video video={tile()} />);
    const audio = container.querySelector('audio') as (HTMLAudioElement & { srcObject: FakeStream }) | null;
    expect(audio).not.toBeNull();
    expect(audio?.autoplay).toBe(true);
    expect(audio?.srcObject.getAudioTracks().map((t) => t.id)).toEqual(['a']);
    expect(audio?.srcObject.getVideoTracks()).toEqual([]);
  });

  it('the picture element is always muted, so the voice is never played twice', () => {
    const { container } = render(<Video video={tile()} />);
    expect(container.querySelector('video')?.muted).toBe(true);
  });

  it('your own tile has no audio element (you do not want to hear yourself)', () => {
    const { container } = render(<Video video={tile({ muted: true })} />);
    expect(container.querySelector('audio')).toBeNull();
    expect(container.querySelector('video')).not.toBeNull();
  });

  it('only your own camera is mirrored', () => {
    const own = render(<Video video={tile({ muted: true })} />).container.querySelector('video');
    const other = render(<Video video={tile({ muted: false })} />).container.querySelector('video');
    const screen = render(<Video video={tile({ muted: true, kind: 'screen' })} />).container.querySelector('video');
    expect(own?.className).toMatch(/horizontalFlip/);
    expect(other?.className).not.toMatch(/horizontalFlip/);
    expect(screen?.className).not.toMatch(/horizontalFlip/);
  });
});
