import AlertService from './AlertService';
import StorageService from './StorageService';
import { createAudioPipeline, isNoiseSuppressionSupported } from './audio/AudioPipeline';
import type { AudioPipeline } from './audio/AudioPipeline';
import { loadRnnoiseEngine } from './audio/RnnoiseEngine';

const STORAGE_KEY = 'noiseSuppression';

/** What the engine is told to build: replaceable in tests. */
export interface NoiseSuppressionEngine {
  supported: () => boolean;
  createPipeline: typeof createAudioPipeline;
}

const realEngine: NoiseSuppressionEngine = { supported: isNoiseSuppressionSupported, createPipeline: createAudioPipeline };

/**
 * Cleans the microphone of fans, keyboards and street noise on this device before it is sent (see
 * docs/voice-cancellation.md). It is on unless the person switched it off, and that choice is remembered on the
 * device. Wherever the browser cannot do it, the plain microphone is used and the browser's own suppression stays on.
 */
export default class NoiseSuppressionService {
  private static on = true;
  private static touched = false;
  private static loaded: Promise<boolean> | undefined;
  private static storage = new StorageService();
  private static engine: NoiseSuppressionEngine = realEngine;
  /** the cleaned track each running pipeline sends -> the pipeline */
  private static pipelines = new Map<MediaStreamTrack, AudioPipeline>();

  /** The person's choice (on unless they switched it off). */
  static get enabled(): boolean {
    return NoiseSuppressionService.on;
  }

  /** Whether the cleaning is running right now, so that the button can switch it at once. */
  static get running(): boolean {
    return NoiseSuppressionService.pipelines.size > 0;
  }

  /** Whether this browser can clean the voice at all (the button is not shown where it cannot). */
  static get supported(): boolean {
    return NoiseSuppressionService.engine.supported();
  }

  /** Reads the choice made earlier on this device (once; the answer is kept). */
  static load(): Promise<boolean> {
    NoiseSuppressionService.loaded ??= (async () => {
      try {
        const stored = await NoiseSuppressionService.storage.get(STORAGE_KEY);
        // a choice made while this was still loading wins over what was stored
        if (!NoiseSuppressionService.touched) NoiseSuppressionService.on = stored !== 'off';
      } catch {
        // storage unavailable (private mode, blocked): the default stays, and is not remembered
      }
      return NoiseSuppressionService.on;
    })();
    return NoiseSuppressionService.loaded;
  }

  /**
   * Switches the cleaning on or off, for the running meeting and for the next ones. Where it was off when the
   * microphone was opened there is nothing to switch on until the next meeting: the answer says so.
   */
  static set(on: boolean): 'applied' | 'next-meeting' {
    NoiseSuppressionService.on = on;
    NoiseSuppressionService.touched = true;
    const remember = on ? NoiseSuppressionService.storage.remove(STORAGE_KEY) : NoiseSuppressionService.storage.set(STORAGE_KEY, 'off');
    remember.catch(() => undefined);
    for (const pipeline of NoiseSuppressionService.pipelines.values()) pipeline.setEnabled(on);
    return on && !NoiseSuppressionService.running ? 'next-meeting' : 'applied';
  }

  /** Whether the next microphone is going to be cleaned: the person wants it and the browser can. */
  static async willClean(): Promise<boolean> {
    await NoiseSuppressionService.load();
    return NoiseSuppressionService.on && NoiseSuppressionService.supported;
  }

  /**
   * The stream to use as the microphone: the cleaned one, or the microphone itself where cleaning is switched off
   * or cannot be done. With the cleaning switched off no audio graph is built at all, so those who do not want it
   * (or whose browser has trouble with it) have exactly the plain microphone.
   */
  static async process(microphone: MediaStream): Promise<MediaStream> {
    await NoiseSuppressionService.load();
    if (!NoiseSuppressionService.on || !NoiseSuppressionService.supported) return microphone;
    try {
      const pipeline = await NoiseSuppressionService.engine.createPipeline(microphone, {
        enabled: true,
        loadEngine: loadRnnoiseEngine,
        onEngineFailed: () => AlertService.push('Noise reduction stopped working and was switched off.'),
      });
      const track = pipeline?.stream.getAudioTracks()[0];
      if (!pipeline || !track) return microphone;
      NoiseSuppressionService.pipelines.set(track, pipeline);
      return pipeline.stream;
    } catch {
      return microphone;
    }
  }

  /** A track was stopped: when it was a cleaned one, the microphone behind it and the audio graph go too. */
  static release(track: MediaStreamTrack): void {
    const pipeline = NoiseSuppressionService.pipelines.get(track);
    if (!pipeline) return;
    NoiseSuppressionService.pipelines.delete(track);
    pipeline.dispose();
  }

  /** For tests. */
  static useEngine(engine: NoiseSuppressionEngine = realEngine): void {
    NoiseSuppressionService.engine = engine;
    NoiseSuppressionService.pipelines.clear();
    NoiseSuppressionService.on = true;
    NoiseSuppressionService.touched = false;
    NoiseSuppressionService.loaded = undefined;
  }
}
