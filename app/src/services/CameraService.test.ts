import { beforeEach, describe, expect, it, vi } from 'vitest';
import CameraService from './CameraService';

function fakeTrack() {
  const listeners = new Map<string, (() => void)[]>();
  const track = {
    kind: 'video',
    readyState: 'live' as 'live' | 'ended',
    contentHint: '',
    stop: vi.fn(() => void (track.readyState = 'ended')),
    addEventListener: (type: string, listener: () => void) => void listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    /** the browser ends the track by itself (unplugged, permission withdrawn) */
    end() {
      track.readyState = 'ended';
      for (const listener of listeners.get('ended') ?? []) listener();
    },
  };
  return track;
}

let getUserMedia: ReturnType<typeof vi.fn>;
let next: ReturnType<typeof fakeTrack>;
beforeEach(() => {
  next = fakeTrack();
  getUserMedia = vi.fn(async () => ({ getVideoTracks: () => [next] }));
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
});

describe('CameraService', () => {
  it('asks for a modest picture and no sound, and is on afterwards', async () => {
    const camera = new CameraService();
    expect(camera.isOn).toBe(false);
    const track = await camera.turnOn();
    expect(track).toBe(next);
    expect(camera.isOn).toBe(true);
    expect(camera.currentTrack).toBe(next);

    const constraints = getUserMedia.mock.calls[0]?.[0];
    expect(constraints.audio).toBe(false);
    expect(constraints.video.width.ideal).toBeLessThanOrEqual(640);
    expect(constraints.video.frameRate.max).toBeLessThanOrEqual(30);
  });

  it('hints that this is a person (smooth beats sharp), unlike a shared screen', async () => {
    const track = await new CameraService().turnOn();
    expect(track.contentHint).toBe('motion');
  });

  it('does not ask the browser again while the camera is already on', async () => {
    const camera = new CameraService();
    await camera.turnOn();
    await camera.turnOn();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('releases the camera when switched off, so its light goes out', async () => {
    const camera = new CameraService();
    await camera.turnOn();
    camera.turnOff();
    expect(next.stop).toHaveBeenCalledTimes(1);
    expect(camera.isOn).toBe(false);
    expect(camera.currentTrack).toBeNull();
    camera.turnOff(); // harmless twice
    expect(next.stop).toHaveBeenCalledTimes(1);
  });

  it('can be switched on again after it was off', async () => {
    const camera = new CameraService();
    await camera.turnOn();
    camera.turnOff();
    next = fakeTrack();
    expect(await camera.turnOn()).toBe(next);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('tells the app when the camera stops by itself', async () => {
    const camera = new CameraService();
    const ended = vi.fn();
    camera.onEnded(ended);
    await camera.turnOn();
    next.end();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(camera.isOn).toBe(false);
  });

  it('does not report the end of a camera that was switched off on purpose', async () => {
    const camera = new CameraService();
    const ended = vi.fn();
    camera.onEnded(ended);
    await camera.turnOn();
    camera.turnOff();
    next.end();
    expect(ended).not.toHaveBeenCalled();
  });

  it('fails when there is no camera or the user said no, and stays off', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('Permission denied', 'NotAllowedError'));
    const camera = new CameraService();
    await expect(camera.turnOn()).rejects.toThrow();
    expect(camera.isOn).toBe(false);
  });
});
