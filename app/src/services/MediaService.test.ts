import { beforeEach, describe, expect, it, vi } from 'vitest';
// the services around it pull in the whole app (router, store, Ionic and Cordova plugins): not needed here
vi.mock('./MeetingService', () => ({ default: class { setMediaStream() {} } }));
vi.mock('./AlertService', () => ({ default: { push: vi.fn() } }));
vi.mock('../routes', () => ({ default: { home: { path: '/home' } } }));

import MediaService from './MediaService';
import NoiseSuppressionService from './NoiseSuppressionService';
import type { AudioPipeline } from './audio/AudioPipeline';

const history = { push: vi.fn() } as never;

function fakeStream(name: string) {
  const track = { name, stopped: false, stop() { this.stopped = true; } };
  return { name, track, getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream & { track: { stopped: boolean } };
}

function openMicrophone(...streams: MediaStream[]) {
  const getUserMedia = vi.fn();
  for (const stream of streams) getUserMedia.mockResolvedValueOnce(stream);
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  return getUserMedia;
}

const browserSuppressionAsked = (getUserMedia: ReturnType<typeof vi.fn>, call: number) =>
  (getUserMedia.mock.calls[call]?.[0] as { audio: { noiseSuppression: boolean } }).audio.noiseSuppression;

async function getStream() {
  const callback = vi.fn();
  await new MediaService().getStream(history, callback);
  return callback.mock.calls[0]?.[0] as MediaStream | undefined;
}

beforeEach(() => {
  localStorage.clear();
  NoiseSuppressionService.useEngine();
});

describe('opening the microphone', () => {
  it('asks for it without the browser\'s noise suppression when ours takes over, and hands out the cleaned stream', async () => {
    const raw = fakeStream('raw');
    const cleaned = fakeStream('cleaned');
    const pipeline = { stream: cleaned, enabled: true, setEnabled: vi.fn(), dispose: vi.fn() } as unknown as AudioPipeline;
    NoiseSuppressionService.useEngine({ supported: () => true, createPipeline: vi.fn(async () => pipeline) });
    const getUserMedia = openMicrophone(raw);

    expect(await getStream()).toBe(cleaned);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(browserSuppressionAsked(getUserMedia, 0)).toBe(false);
    expect(getUserMedia.mock.calls[0]?.[0]).toMatchObject({ audio: { echoCancellation: true, autoGainControl: true } });
  });

  it('opens it the way it always was, with the browser\'s suppression, when our cleaning cannot start', async () => {
    const first = fakeStream('first');
    const second = fakeStream('second');
    NoiseSuppressionService.useEngine({ supported: () => true, createPipeline: vi.fn(async () => null) });
    const getUserMedia = openMicrophone(first, second);

    expect(await getStream()).toBe(second);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(browserSuppressionAsked(getUserMedia, 0)).toBe(false);
    expect(browserSuppressionAsked(getUserMedia, 1)).toBe(true);
    expect((first as unknown as { track: { stopped: boolean } }).track.stopped).toBe(true); // the first one is not left open
  });

  it('keeps the browser\'s suppression and builds nothing for somebody who switched ours off', async () => {
    const raw = fakeStream('raw');
    const createPipeline = vi.fn();
    NoiseSuppressionService.useEngine({ supported: () => true, createPipeline });
    NoiseSuppressionService.set(false);
    const getUserMedia = openMicrophone(raw);

    expect(await getStream()).toBe(raw);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(browserSuppressionAsked(getUserMedia, 0)).toBe(true);
    expect(createPipeline).not.toHaveBeenCalled();
  });

  it('keeps the browser\'s suppression where the browser cannot run ours', async () => {
    const raw = fakeStream('raw');
    NoiseSuppressionService.useEngine({ supported: () => false, createPipeline: vi.fn() });
    const getUserMedia = openMicrophone(raw);
    expect(await getStream()).toBe(raw);
    expect(browserSuppressionAsked(getUserMedia, 0)).toBe(true);
  });

  it('also cleans the microphone that goes with a shared screen', async () => {
    const cleaned = fakeStream('cleaned');
    const pipeline = { stream: cleaned, enabled: true, setEnabled: vi.fn(), dispose: vi.fn() } as unknown as AudioPipeline;
    NoiseSuppressionService.useEngine({ supported: () => true, createPipeline: vi.fn(async () => pipeline) });
    openMicrophone(fakeStream('raw'));
    const callback = vi.fn();
    await new MediaService().getAudioStream(callback);
    expect(callback).toHaveBeenCalledWith(cleaned);
  });
});
