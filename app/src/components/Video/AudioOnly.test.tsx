import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { VideoState } from '../../pages/Meeting/Meeting.state';

const isHostMeeting = vi.fn((id: string) => id === 'host-id');
vi.mock('../../services/MeetingService', () => ({
  default: class {
    isHostMeeting = isHostMeeting;
  },
}));

const { default: AudioOnly, hasPicture, tileLabel } = await import('./AudioOnly');

class FakeStream {
  listeners = new Map<string, (() => void)[]>();
  constructor(private tracks: { readyState: string }[]) {}
  getVideoTracks() {
    return this.tracks;
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
  }
  fire(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  add(track: { readyState: string }) {
    this.tracks = [...this.tracks, track];
    this.fire('addtrack');
  }
}

const tile = (stream: FakeStream, overrides: Partial<VideoState> = {}): VideoState => ({
  id: 'peer-1',
  stream: stream as unknown as MediaStream,
  kind: 'media',
  raiseHand: false,
  memberRemove: false,
  active: false,
  muted: false,
  streamMuted: { video: false, audio: false },
  renderId: 'r',
  ...overrides,
});

describe('hasPicture', () => {
  it('is false for a voice-only stream, true for a live video track', () => {
    expect(hasPicture(tile(new FakeStream([])))).toBe(false);
    expect(hasPicture(tile(new FakeStream([{ readyState: 'live' }])))).toBe(true);
  });

  it('a shared screen is a picture even though the camera is off', () => {
    expect(hasPicture(tile(new FakeStream([{ readyState: 'live' }]), { kind: 'screen', streamMuted: { video: true, audio: false } }))).toBe(true);
  });

  it('a live video line is not a picture until the camera is announced as on', () => {
    expect(hasPicture(tile(new FakeStream([{ readyState: 'live' }]), { streamMuted: { video: true, audio: false } }))).toBe(false);
  });

  it('is false for an ended track and when the app switched the video off', () => {
    expect(hasPicture(tile(new FakeStream([{ readyState: 'ended' }])))).toBe(false);
    expect(hasPicture(tile(new FakeStream([{ readyState: 'live' }]), { streamMuted: { video: true, audio: false } }))).toBe(false);
  });
});

describe('tileLabel', () => {
  it('names you, the host and everybody else', () => {
    const host = (id: string) => id === 'host-id';
    expect(tileLabel({ id: 'me', muted: true }, host)).toBe('You');
    expect(tileLabel({ id: 'host-id', muted: false }, host)).toBe('Host');
    expect(tileLabel({ id: 'someone', muted: false }, host)).toBe('Participant');
  });

  it('shows the name a person chose, and still marks the host', () => {
    const host = (id: string) => id === 'host-id';
    expect(tileLabel({ id: 'someone', muted: false, name: 'Bob Chen' }, host)).toBe('Bob Chen');
    expect(tileLabel({ id: 'host-id', muted: false, name: 'Alice' }, host)).toBe('Alice (Host)');
    // your own tile is always "You", whatever you called yourself
    expect(tileLabel({ id: 'me', muted: true, name: 'Me Myself' }, host)).toBe('You');
  });
});

describe('AudioOnly', () => {
  it('covers a tile that has no picture, with the label of whose tile it is', () => {
    render(<AudioOnly video={tile(new FakeStream([]), { id: 'host-id' })} />);
    expect(screen.getByLabelText('Host, audio only')).toBeTruthy();
    expect(screen.getByText('Host')).toBeTruthy();
  });

  it('says "You" on the local tile', () => {
    render(<AudioOnly video={tile(new FakeStream([]), { muted: true })} />);
    expect(screen.getByText('You')).toBeTruthy();
  });

  it('does not cover a shared screen', () => {
    const { container } = render(<AudioOnly video={tile(new FakeStream([{ readyState: 'live' }]), { kind: 'screen' })} />);
    expect(container.firstChild).toBeNull();
  });

  it('goes away when a picture arrives on the same stream, and comes back when it ends', async () => {
    const stream = new FakeStream([]);
    const { container } = render(<AudioOnly video={tile(stream)} />);
    expect(container.firstChild).not.toBeNull();

    const { act } = await import('@testing-library/react');
    const track = { readyState: 'live' };
    act(() => stream.add(track));
    expect(container.firstChild).toBeNull();

    track.readyState = 'ended';
    act(() => stream.fire('removetrack'));
    expect(container.firstChild).not.toBeNull();
  });
});
