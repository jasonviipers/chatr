import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudioPipeline } from './AudioPipeline';

class FakeParam {
  value = 0;
  setTargetAtTime = vi.fn((value: number) => {
    this.value = value;
  });
}

class FakeNode {
  out = new Set<unknown>();
  connect = vi.fn((node: unknown) => {
    this.out.add(node);
    return node;
  });
  disconnect = vi.fn((node?: unknown) => {
    if (node === undefined) this.out.clear();
    else this.out.delete(node);
  });
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeEngine extends FakeNode {
  destroy = vi.fn();
  onprocessorerror: (() => void) | null = null;
}

function fakeTrack() {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    contentHint: '',
    stopped: false,
    stop() {
      this.stopped = true;
    },
    addEventListener(type: string, listener: () => void) {
      (listeners[type] ??= []).push(listener);
    },
    fire(type: string) {
      listeners[type]?.forEach((listener) => listener());
    },
  };
}

const fakeStream = (track: ReturnType<typeof fakeTrack>) =>
  ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream;

function setup(overrides: Record<string, unknown> = {}) {
  const raw = fakeTrack();
  const output = fakeTrack();
  const microphone = fakeStream(raw);
  const destination = Object.assign(new FakeNode(), { channelCount: 2, stream: fakeStream(output) });
  const source = new FakeNode();
  const gains: FakeGain[] = [];
  const context = {
    sampleRate: 48_000,
    state: 'running',
    currentTime: 1,
    onstatechange: null as (() => void) | null,
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createGain: vi.fn(() => {
      const gain = new FakeGain();
      gains.push(gain);
      return gain;
    }),
    createMediaStreamSource: vi.fn(() => source),
    createMediaStreamDestination: vi.fn(() => destination),
    ...overrides,
  };
  const engine = new FakeEngine();
  const options = (enabled = true) => ({
    enabled,
    loadEngine: vi.fn(async () => engine as unknown as AudioNode),
    createContext: () => context as unknown as AudioContext,
  });
  // the pipeline creates the clean gain first, then the raw one
  return { raw, output, microphone, destination, source, context, engine, gains, options };
}

afterEach(() => vi.useRealTimers());

describe('createAudioPipeline', () => {
  it('sends the microphone through the engine into one mono output track, as speech', async () => {
    const t = setup();
    const pipeline = await createAudioPipeline(t.microphone, t.options(true));
    expect(pipeline).not.toBeNull();
    const [cleanGain, rawGain] = t.gains;
    expect(pipeline?.stream).toBe(t.destination.stream);
    expect(t.destination.channelCount).toBe(1);
    expect(t.output.contentHint).toBe('speech');
    // one channel taken as it is: averaging two channels of which one is empty would halve the voice
    for (const gain of t.gains) {
      expect(gain).toMatchObject({ channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    }
    expect(t.engine.out.has(cleanGain)).toBe(true);
    expect(cleanGain?.out.has(t.destination)).toBe(true);
    expect(rawGain?.out.has(t.destination)).toBe(true);
    expect(t.source.out.has(t.engine)).toBe(true);
    expect(t.source.out.has(rawGain)).toBe(true);
    // the cleaned voice is what is heard
    expect(cleanGain?.gain.value).toBe(1);
    expect(rawGain?.gain.value).toBe(0);
    expect(pipeline?.enabled).toBe(true);
  });

  it('can start with the cleaning off: the raw voice is heard and the engine is not even connected', async () => {
    const t = setup();
    const pipeline = await createAudioPipeline(t.microphone, t.options(false));
    const [cleanGain, rawGain] = t.gains;
    expect(pipeline?.enabled).toBe(false);
    expect(cleanGain?.gain.value).toBe(0);
    expect(rawGain?.gain.value).toBe(1);
    expect(t.source.out.has(t.engine)).toBe(false);
  });

  it('switches on and off with a crossfade, and lets the engine rest while it is not heard', async () => {
    vi.useFakeTimers();
    const t = setup();
    const pipeline = await createAudioPipeline(t.microphone, t.options(true));
    const [cleanGain, rawGain] = t.gains;

    pipeline?.setEnabled(false);
    expect(cleanGain?.gain.value).toBe(0);
    expect(rawGain?.gain.value).toBe(1);
    expect(t.source.out.has(t.engine)).toBe(true); // not yet: the fade has to finish
    vi.advanceTimersByTime(200);
    expect(t.source.out.has(t.engine)).toBe(false);

    pipeline?.setEnabled(true);
    expect(t.source.out.has(t.engine)).toBe(true);
    expect(cleanGain?.gain.value).toBe(1);
    expect(rawGain?.gain.value).toBe(0);

    // switched on again before the engine was disconnected: it stays connected
    pipeline?.setEnabled(false);
    pipeline?.setEnabled(true);
    vi.advanceTimersByTime(500);
    expect(t.source.out.has(t.engine)).toBe(true);
  });

  it('falls back to the plain microphone (null) wherever it cannot run, and leaves nothing open', async () => {
    const none = setup();
    const noTrack = { getAudioTracks: () => [], getTracks: () => [] } as unknown as MediaStream;
    expect(await createAudioPipeline(noTrack, none.options())).toBeNull();

    const wrongRate = setup({ sampleRate: 44_100 });
    expect(await createAudioPipeline(wrongRate.microphone, wrongRate.options())).toBeNull();
    expect(wrongRate.context.close).toHaveBeenCalled();

    // a context that cannot start without a click would send silence
    const suspended = setup({ state: 'suspended' });
    expect(await createAudioPipeline(suspended.microphone, suspended.options())).toBeNull();
    expect(suspended.context.close).toHaveBeenCalled();

    const broken = setup();
    const failing = { ...broken.options(), loadEngine: vi.fn(async () => Promise.reject(new Error('no wasm'))) };
    expect(await createAudioPipeline(broken.microphone, failing)).toBeNull();
    expect(broken.context.close).toHaveBeenCalled();
    expect(broken.raw.stopped).toBe(false); // the caller still uses the microphone
  });

  it('gives up on an engine that never loads', async () => {
    vi.useFakeTimers();
    const t = setup();
    const never = { ...t.options(), loadEngine: () => new Promise<AudioNode>(() => undefined) };
    const result = createAudioPipeline(t.microphone, never);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await result).toBeNull();
    expect(t.context.close).toHaveBeenCalled();
  });

  it('stops the microphone and closes the audio graph once, however often it is disposed', async () => {
    const t = setup();
    const pipeline = await createAudioPipeline(t.microphone, t.options());
    pipeline?.dispose();
    pipeline?.dispose();
    expect(t.raw.stopped).toBe(true);
    expect(t.output.stopped).toBe(true);
    expect(t.engine.destroy).toHaveBeenCalledTimes(1);
    expect(t.context.close).toHaveBeenCalledTimes(1);
    pipeline?.setEnabled(false); // no effect after the end
    expect(t.gains[1]?.gain.setTargetAtTime).not.toHaveBeenCalledWith(1, expect.anything(), expect.anything());
  });

  it('ends with the microphone when it is unplugged', async () => {
    const t = setup();
    await createAudioPipeline(t.microphone, t.options());
    t.raw.fire('ended');
    expect(t.output.stopped).toBe(true);
    expect(t.context.close).toHaveBeenCalled();
  });

  it('carries on with the raw voice when the engine crashes, and says so', async () => {
    const t = setup();
    const onEngineFailed = vi.fn();
    const pipeline = await createAudioPipeline(t.microphone, { ...t.options(), onEngineFailed });
    t.engine.onprocessorerror?.();
    expect(pipeline?.enabled).toBe(false);
    expect(t.gains[1]?.gain.value).toBe(1);
    expect(onEngineFailed).toHaveBeenCalledTimes(1);
  });

  it('starts the audio context again when the system suspends it', async () => {
    const t = setup();
    await createAudioPipeline(t.microphone, t.options());
    t.context.resume.mockClear();
    t.context.state = 'suspended';
    t.context.onstatechange?.();
    expect(t.context.resume).toHaveBeenCalledTimes(1);
    t.context.state = 'closed';
    t.context.onstatechange?.();
    expect(t.context.resume).toHaveBeenCalledTimes(1);
  });
});
