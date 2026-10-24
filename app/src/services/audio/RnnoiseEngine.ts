import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

// The wasm file is the same for every context: fetched once, the first time it is needed
let wasmBinary: Promise<ArrayBuffer> | undefined;

/**
 * RNNoise (BSD-3-Clause, through @sapphi-red/web-noise-suppressor, MIT) as an AudioWorklet node. Nothing of it is
 * loaded until somebody joins a meeting with a microphone: the library, the worklet and the WebAssembly all come
 * from this site's own files (a few hundred kilobytes).
 */
export async function loadRnnoiseEngine(context: AudioContext): Promise<AudioNode> {
  const library = await import('@sapphi-red/web-noise-suppressor');
  wasmBinary ??= library.loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl });
  try {
    const [binary] = await Promise.all([wasmBinary, context.audioWorklet.addModule(rnnoiseWorkletUrl)]);
    return new library.RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary: binary });
  } catch (error) {
    wasmBinary = undefined; // a failed download is tried again next time
    throw error;
  }
}
