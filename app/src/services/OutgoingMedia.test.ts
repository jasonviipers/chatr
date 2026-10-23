import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeStream {
  constructor(private tracks: FakeTrack[] = []) {}
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getTracks() {
    return this.tracks;
  }
}
interface FakeTrack {
  kind: 'audio' | 'video';
  id: string;
  readyState: 'live' | 'ended';
}
const track = (kind: 'audio' | 'video', id: string, readyState: 'live' | 'ended' = 'live'): FakeTrack => ({ kind, id, readyState });

/** The little of RTCPeerConnection these helpers use. */
function fakeConnection(options: { negotiated?: boolean; videoTrack?: FakeTrack | null } = {}) {
  const listeners: (() => void)[] = [];
  const audioSender = { track: track('audio', 'mic') as FakeTrack | null, replaceTrack: vi.fn(async function (this: unknown, next: FakeTrack | null) { audioSender.track = next; }) };
  const videoSender = { track: (options.videoTrack ?? null) as FakeTrack | null, replaceTrack: vi.fn(async (next: FakeTrack | null) => { videoSender.track = next; }) };
  const connection = {
    signalingState: options.negotiated === false ? 'have-local-offer' : 'stable',
    remoteDescription: options.negotiated === false ? null : {},
    localDescription: {},
    getSenders: () => [audioSender, videoSender],
    getTransceivers: () => [
      { receiver: { track: { kind: 'audio' } }, sender: audioSender },
      { receiver: { track: { kind: 'video' } }, sender: videoSender },
    ],
    addEventListener: vi.fn((_type: string, listener: () => void) => void listeners.push(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) => void listeners.splice(listeners.indexOf(listener), 1)),
    /** the answer arrives */
    finishNegotiation() {
      connection.signalingState = 'stable';
      connection.remoteDescription = {};
      for (const listener of [...listeners]) listener();
    },
  };
  return { connection: connection as unknown as RTCPeerConnection & { finishNegotiation(): void }, audioSender, videoSender };
}

let captured: FakeTrack;
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('MediaStream', FakeStream);
  captured = track('video', 'placeholder');
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ fillStyle: '', fillRect: vi.fn() })) as never;
  (HTMLCanvasElement.prototype as unknown as { captureStream: () => unknown }).captureStream = () => new FakeStream([captured]);
});

async function load() {
  return import('./OutgoingMedia');
}

describe('the placeholder', () => {
  it('is one track, reused while it lives, and replaced once it has ended', async () => {
    const media = await load();
    const first = media.placeholderTrack();
    expect(media.placeholderTrack()).toBe(first);
    expect(media.isPlaceholder(first)).toBe(true);
    expect(media.isPlaceholder(track('video', 'other') as MediaStreamTrack)).toBe(false);

    captured.readyState = 'ended';
    captured = track('video', 'placeholder-2');
    expect(media.placeholderTrack()).not.toBe(first);
  });
});

describe('callStream', () => {
  it('carries the voice and the picture when there is one', async () => {
    const media = await load();
    const camera = track('video', 'camera');
    const stream = media.callStream(new FakeStream([track('audio', 'mic'), camera]) as unknown as MediaStream) as unknown as FakeStream;
    expect(stream.getTracks().map((t) => t.id)).toEqual(['mic', 'camera']);
  });

  it('opens a video line with the placeholder when there is no picture, so the camera can be switched on later', async () => {
    const media = await load();
    const stream = media.callStream(new FakeStream([track('audio', 'mic')]) as unknown as MediaStream) as unknown as FakeStream;
    expect(stream.getVideoTracks().map((t) => t.id)).toEqual(['placeholder']);
    expect(stream.getAudioTracks()).toHaveLength(1);
  });

  it('does not take a picture that has ended for a picture', async () => {
    const media = await load();
    const stream = media.callStream(new FakeStream([track('audio', 'mic'), track('video', 'gone', 'ended')]) as unknown as MediaStream) as unknown as FakeStream;
    expect(stream.getVideoTracks().map((t) => t.id)).toEqual(['placeholder']);
  });
});

describe('the video line of a call', () => {
  it('finds the sender through the transceivers, even when it carries nothing', async () => {
    const media = await load();
    const { connection, videoSender } = fakeConnection({ videoTrack: null });
    expect(media.videoSenderOf(connection)).toBe(videoSender);
  });

  it('puts a track on it, takes it off again, and leaves it alone when nothing changes', async () => {
    const media = await load();
    const { connection, videoSender } = fakeConnection();
    const camera = track('video', 'camera') as MediaStreamTrack;

    await media.setVideoTrack(connection, camera);
    expect(videoSender.replaceTrack).toHaveBeenCalledWith(camera);
    await media.setVideoTrack(connection, camera); // already there
    expect(videoSender.replaceTrack).toHaveBeenCalledTimes(1);
    await media.setVideoTrack(connection, null);
    expect(videoSender.track).toBeNull();
  });

  it('does not fail when the call is closing', async () => {
    const media = await load();
    const { connection, videoSender } = fakeConnection();
    videoSender.replaceTrack.mockRejectedValueOnce(new Error('closed'));
    await expect(media.setVideoTrack(connection, track('video', 'camera') as MediaStreamTrack)).resolves.toBeUndefined();
  });

  it('a call without a video line (made by an older version) is left alone', async () => {
    const media = await load();
    const connection = { getTransceivers: () => [{ receiver: { track: { kind: 'audio' } }, sender: {} }] } as unknown as RTCPeerConnection;
    await expect(media.setVideoTrack(connection, null)).resolves.toBeUndefined();
  });
});

describe('settling a call', () => {
  it('takes the placeholder off once the call is negotiated, not before', async () => {
    const media = await load();
    const placeholder = media.placeholderTrack();
    const { connection, videoSender } = fakeConnection({ negotiated: false, videoTrack: placeholder as unknown as FakeTrack });

    media.settleCall(connection, () => null);
    expect(videoSender.replaceTrack).not.toHaveBeenCalled(); // an empty line could lose its stream in the offer

    connection.finishNegotiation();
    await Promise.resolve();
    expect(videoSender.replaceTrack).toHaveBeenCalledWith(null);
    expect(connection.removeEventListener).toHaveBeenCalled();
  });

  it('settles at once when the call is already negotiated (a re-dial answered quickly)', async () => {
    const media = await load();
    const { connection, videoSender } = fakeConnection({ videoTrack: track('video', 'placeholder') });
    media.settleCall(connection, () => null);
    await Promise.resolve();
    expect(videoSender.replaceTrack).toHaveBeenCalledWith(null);
  });

  it('puts the camera on the line if it was switched on while the call was being set up', async () => {
    const media = await load();
    const { connection, videoSender } = fakeConnection({ negotiated: false, videoTrack: track('video', 'placeholder') });
    const camera = track('video', 'camera') as MediaStreamTrack;
    let desired: MediaStreamTrack | null = null;
    media.settleCall(connection, () => desired);

    desired = camera; // switched on during the handshake: the answer is read when it is needed, not before
    connection.finishNegotiation();
    await Promise.resolve();
    expect(videoSender.replaceTrack).toHaveBeenCalledWith(camera);
  });
});
