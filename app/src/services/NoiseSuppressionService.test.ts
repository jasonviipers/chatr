import { beforeEach, describe, expect, it, vi } from 'vitest';
import NoiseSuppressionService from './NoiseSuppressionService';
import type { AudioPipeline } from './audio/AudioPipeline';

const track = (name: string) => ({ name }) as unknown as MediaStreamTrack;
const streamOf = (audio: MediaStreamTrack) => ({ getAudioTracks: () => [audio], getTracks: () => [audio] }) as unknown as MediaStream;

function fakePipeline() {
  const cleaned = track('cleaned');
  const pipeline = {
    stream: streamOf(cleaned),
    enabled: true,
    setEnabled: vi.fn(),
    dispose: vi.fn(),
  };
  return { cleaned, pipeline };
}

function useEngine(overrides: { supported?: boolean; pipeline?: AudioPipeline | null | Error } = {}) {
  const { supported = true, pipeline = fakePipeline().pipeline } = overrides;
  const createPipeline = vi.fn(async () => {
    if (pipeline instanceof Error) throw pipeline;
    return pipeline;
  });
  NoiseSuppressionService.useEngine({ supported: () => supported, createPipeline });
  return createPipeline;
}

beforeEach(() => {
  localStorage.clear();
  NoiseSuppressionService.useEngine();
});

describe('NoiseSuppressionService.process', () => {
  it('hands out the cleaned stream, and the engine is switched on', async () => {
    const { cleaned, pipeline } = fakePipeline();
    const createPipeline = useEngine({ pipeline });
    const microphone = streamOf(track('raw'));
    const result = await NoiseSuppressionService.process(microphone);
    expect(result).toBe(pipeline.stream);
    expect(createPipeline).toHaveBeenCalledWith(microphone, expect.objectContaining({ enabled: true }));
    expect(NoiseSuppressionService.running).toBe(true);
    NoiseSuppressionService.release(cleaned);
    expect(pipeline.dispose).toHaveBeenCalledTimes(1);
    expect(NoiseSuppressionService.running).toBe(false);
  });

  it('keeps the plain microphone wherever it cannot be cleaned', async () => {
    const microphone = streamOf(track('raw'));
    const unsupported = useEngine({ supported: false });
    expect(await NoiseSuppressionService.process(microphone)).toBe(microphone);
    expect(unsupported).not.toHaveBeenCalled();

    useEngine({ pipeline: null });
    expect(await NoiseSuppressionService.process(microphone)).toBe(microphone);

    useEngine({ pipeline: new Error('boom') });
    expect(await NoiseSuppressionService.process(microphone)).toBe(microphone);
    expect(NoiseSuppressionService.running).toBe(false);
  });

  it('builds nothing at all for somebody who switched the cleaning off', async () => {
    const createPipeline = useEngine();
    NoiseSuppressionService.set(false);
    const microphone = streamOf(track('raw'));
    expect(await NoiseSuppressionService.process(microphone)).toBe(microphone);
    expect(createPipeline).not.toHaveBeenCalled();
  });
});

describe('NoiseSuppressionService.set', () => {
  it('switches the running pipeline at once', async () => {
    const { pipeline } = fakePipeline();
    useEngine({ pipeline });
    await NoiseSuppressionService.process(streamOf(track('raw')));

    expect(NoiseSuppressionService.set(false)).toBe('applied');
    expect(pipeline.setEnabled).toHaveBeenLastCalledWith(false);
    expect(NoiseSuppressionService.enabled).toBe(false);
    expect(NoiseSuppressionService.set(true)).toBe('applied');
    expect(pipeline.setEnabled).toHaveBeenLastCalledWith(true);
  });

  it('says the cleaning starts with the next meeting when none is running', () => {
    useEngine();
    NoiseSuppressionService.set(false);
    expect(NoiseSuppressionService.set(true)).toBe('next-meeting');
    expect(NoiseSuppressionService.enabled).toBe(true);
  });
});

describe('NoiseSuppressionService.load', () => {
  it('is on unless the person switched it off on this device, and remembers the choice', async () => {
    expect(await NoiseSuppressionService.load()).toBe(true);

    NoiseSuppressionService.useEngine();
    NoiseSuppressionService.set(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    NoiseSuppressionService.useEngine(); // a new start of the app: the memory is empty, the device is not
    expect(await NoiseSuppressionService.load()).toBe(false);

    NoiseSuppressionService.useEngine();
    NoiseSuppressionService.set(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    NoiseSuppressionService.useEngine();
    expect(await NoiseSuppressionService.load()).toBe(true);
  });
});
