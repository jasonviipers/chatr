/**
 * The microphone on its way to the call: the raw track goes through a noise suppressor and the result is a new
 * stream that the rest of the app uses as if it were the microphone (the local tile, every call, the mute
 * button). Everything runs in the browser, on this device: calls are peer to peer, so nobody else could clean the
 * voice, and nothing is sent anywhere for it. See docs/voice-cancellation.md.
 *
 *   microphone ─► source ─┬─► engine (RNNoise) ─► cleanGain ─┐
 *                         └──────────────────────► rawGain ──┴─► destination ─► the stream the call sends
 *
 * Switching the suppression on or off only moves the two gains, so the track a call is sending never changes and
 * nothing has to be renegotiated.
 */

/** RNNoise works at 48 kHz, and so does Opus. */
export const SAMPLE_RATE = 48_000;

/** Time constant of the crossfade between the raw and the cleaned voice, in seconds (`setTargetAtTime`). */
const FADE_TIME_CONSTANT = 0.01;
/** How long the engine keeps running after a switch off, so the fade has finished before it is disconnected. */
const DISCONNECT_DELAY_MS = 150;
const RESUME_TIMEOUT_MS = 1_500;
const ENGINE_TIMEOUT_MS = 6_000;

export interface AudioPipeline {
  /** What the app uses as the microphone: one audio track. */
  readonly stream: MediaStream;
  readonly enabled: boolean;
  /** Cleaned (true) or as it comes from the microphone (false). Immediate, no renegotiation. */
  setEnabled(on: boolean): void;
  /** Stops the microphone, closes the audio context. Safe to call twice. */
  dispose(): void;
}

export interface AudioPipelineOptions {
  /** Start with the suppression on. */
  enabled: boolean;
  /** Builds the suppressor node in the given context (it loads whatever the engine needs). */
  loadEngine: (context: AudioContext) => Promise<AudioNode>;
  /** The engine stopped working while the call was running: the pipeline has switched itself to the raw voice. */
  onEngineFailed?: () => void;
  /** For tests. */
  createContext?: () => AudioContext;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Whether this browser can run the suppressor at all (an AudioWorklet and WebAssembly). */
export function isNoiseSuppressionSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.AudioContext === 'function' &&
    typeof AudioWorkletNode === 'function' &&
    typeof WebAssembly === 'object'
  );
}

interface Parts {
  context: AudioContext;
  microphone: MediaStream;
  rawTrack: MediaStreamTrack;
  source: MediaStreamAudioSourceNode;
  engine: AudioNode;
  cleanGain: GainNode;
  rawGain: GainNode;
  destination: MediaStreamAudioDestinationNode;
  outputTrack: MediaStreamTrack;
}

/**
 * Builds the pipeline for an open microphone stream, or answers `null` when that cannot be done here (no
 * AudioWorklet, the audio context cannot start without a click, the engine does not load in time, a sample rate
 * the browser cannot connect...). Then the caller keeps using a plain microphone.
 *
 * The microphone must have been opened without the browser's own noise suppression (see MediaService): a browser
 * cannot switch that on or off for a running microphone, and cleaning the voice twice only makes it worse.
 */
export async function createAudioPipeline(
  microphone: MediaStream,
  options: AudioPipelineOptions,
): Promise<AudioPipeline | null> {
  const rawTrack = microphone.getAudioTracks()[0];
  if (!rawTrack) return null;

  let context: AudioContext | undefined;
  try {
    context = options.createContext
      ? options.createContext()
      : new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    if (context.sampleRate !== SAMPLE_RATE) throw new Error('the audio context does not run at 48 kHz');
    // a context that cannot start without a click would send silence: better not to use it at all
    await withTimeout(context.resume(), RESUME_TIMEOUT_MS, 'starting the audio context');
    if (context.state !== 'running') throw new Error('the audio context is not running');

    const engine = await withTimeout(options.loadEngine(context), ENGINE_TIMEOUT_MS, 'loading the noise suppressor');
    const source = context.createMediaStreamSource(microphone);
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 1;
    const cleanGain = context.createGain();
    const rawGain = context.createGain();
    // One voice, one channel all the way. The suppressor fills the first channel only, and the usual way of
    // mixing two channels down to one is to average them, which would halve the voice (6 dB): take channel 0 as is.
    for (const node of [cleanGain, rawGain]) {
      node.channelCount = 1;
      node.channelCountMode = 'explicit';
      node.channelInterpretation = 'discrete';
    }
    engine.connect(cleanGain);
    cleanGain.connect(destination);
    source.connect(rawGain);
    rawGain.connect(destination);

    const outputTrack = destination.stream.getAudioTracks()[0];
    if (!outputTrack) throw new Error('no output track');
    outputTrack.contentHint = 'speech';

    return buildPipeline({ context, microphone, rawTrack, source, engine, cleanGain, rawGain, destination, outputTrack }, options);
  } catch {
    // never leave a half-built graph (and a tap on the microphone) behind
    void context?.close().catch(() => undefined);
    return null;
  }
}

function buildPipeline(parts: Parts, options: AudioPipelineOptions): AudioPipeline {
  const { context, microphone, rawTrack, source, engine, cleanGain, rawGain, destination, outputTrack } = parts;
  let enabled = false;
  let disposed = false;
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const fadeTo = (clean: number) => {
    const now = context.currentTime;
    cleanGain.gain.setTargetAtTime(clean, now, FADE_TIME_CONSTANT);
    rawGain.gain.setTargetAtTime(1 - clean, now, FADE_TIME_CONSTANT);
  };

  const setEnabled = (on: boolean) => {
    if (disposed || on === enabled) return;
    enabled = on;
    clearTimeout(disconnectTimer);
    if (on) {
      source.connect(engine);
      fadeTo(1);
    } else {
      fadeTo(0);
      // the engine is only worth its processor time while it is heard
      disconnectTimer = setTimeout(() => {
        if (!enabled && !disposed) source.disconnect(engine);
      }, DISCONNECT_DELAY_MS);
    }
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(disconnectTimer);
    context.onstatechange = null;
    for (const track of microphone.getTracks()) track.stop();
    outputTrack.stop();
    try {
      source.disconnect();
      engine.disconnect();
      (engine as { destroy?: () => void }).destroy?.();
    } catch {
      // already disconnected
    }
    void context.close().catch(() => undefined);
  };

  // A context the system suspends (a call comes in on a phone, the tab was frozen) stops sending: start it again
  context.onstatechange = () => {
    if (!disposed && context.state !== 'running' && context.state !== 'closed') void context.resume().catch(() => undefined);
  };
  // The suppressor crashed: carry on with the raw voice, which the person still hears as a normal call
  (engine as AudioWorkletNode).onprocessorerror = () => {
    if (disposed) return;
    setEnabled(false);
    options.onEngineFailed?.();
  };
  // The microphone went away (unplugged, permission withdrawn): the call has nothing to send, as before
  rawTrack.addEventListener('ended', dispose);

  cleanGain.gain.value = 0;
  rawGain.gain.value = 1;
  setEnabled(options.enabled);

  return {
    stream: destination.stream,
    get enabled() {
      return enabled;
    },
    setEnabled,
    dispose,
  };
}
