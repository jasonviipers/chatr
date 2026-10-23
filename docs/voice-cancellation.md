# Voice cancellation (noise suppression): architecture

Status: **proposal, not built.** The goal is that someone in a noisy place (fan, keyboard, street, a family
at home) can keep their microphone on and be understood, with the noise removed on their own device before
it is sent. The text chat covers the case where they do not want to speak at all.

## Why it has to run in the browser

Calls are peer to peer (a WebRTC mesh): the audio never passes through our server, so the server cannot clean
it. Every participant cleans their *own* microphone before it is encoded and sent. That has two good side
effects: it costs the listeners nothing, and it lowers the bitrate Opus needs, which helps on bad networks.
(Cleaning on the server only becomes possible if the project ever moves to an SFU, see phase 4.)

## Where it plugs into the app

Today `MediaService.getStream()` asks for `{ audio: true, video: false }` and the result is used everywhere
(the local tile, every call, the mute button, screen-share switching). The cleaned audio must be **the stream
that `getStream()` returns**, so nothing else has to change:

```
microphone ──getUserMedia──► browser echo cancellation + gain control   (constraints, stays on)
                                   │            (browser noise suppression is switched OFF here, so
                                   ▼             the audio is not suppressed twice)
                         MediaStreamAudioSourceNode
                                   │
                         ┌─────────▼──────────┐   AudioWorklet (own thread, 10 ms frames)
                         │  noise suppressor  │   RNNoise or GTCRN compiled to WebAssembly
                         └─────────┬──────────┘
                                   │
                         (optional noise gate)        silences what is left between words
                                   │
                         MediaStreamAudioDestinationNode
                                   │
                                   ▼
                    processed MediaStream  ──►  local tile, PeerJS calls, mute button, screen-share switch
```

New code is one small module, `app/src/services/audio/NoiseSuppression.ts`, with this shape:

```ts
interface AudioPipeline {
  stream: MediaStream;                 // what getStream() hands out
  setEnabled(on: boolean): void;       // switch at runtime, without renegotiating the call
  dispose(): void;                     // stops the microphone, closes the AudioContext
}
createAudioPipeline(options): Promise<AudioPipeline>   // falls back to the plain stream when unsupported
```

Existing code that has to change, and how little:

| Existing code | Change |
| --- | --- |
| `MediaService.getStream` | build the pipeline instead of using the raw stream; keep `setMediaStream` |
| `MediaService.toggleAudioMute` | none: the pipeline's output track is a normal track, `enabled` works |
| `StreamTrackService.stop` / `exitMeeting` | call `pipeline.dispose()` too, because stopping the output track does not stop the microphone behind it |
| `switchUserStreamToMedia` | reuse the running pipeline instead of opening the microphone again |
| `Menu` / `MenuItems` | one toggle (a long press or a small popover on the microphone button), the choice is remembered in `localStorage` |

Switching on and off at runtime is a gain/bypass change *inside* the graph (a crossfade between the raw and the
cleaned signal), so the track the call is already sending never changes and no SDP renegotiation is needed.

## Which engine

Checked on npm on 2026-10-23.

| Option | What it is | Verdict |
| --- | --- | --- |
| Browser constraints (`noiseSuppression`, `echoCancellation`, `autoGainControl`, and `voiceIsolation` where it exists) | built into Chrome, Edge, Safari, Firefox | **phase 0**: costs nothing, but quality varies by browser and OS |
| [`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor) 0.4.1, MIT, updated Sept 2026 | AudioWorklet nodes for RNNoise, Speex, GTCRN and a noise gate, with a Vite recipe | **phase 1**: smallest integration, three engines behind one API |
| [`@shiguredo/noise-suppression`](https://github.com/shiguredo/media-processors) 2025.1.0, Apache-2.0 | RNNoise based, works on a `MediaStreamTrack` | alternative to the above, larger (about 5 MB unpacked) |
| DeepFilterNet3 (WebAssembly) | best quality of the open models, heavier | **phase 2**, desktop only, behind a flag; the existing npm wrapper is tied to LiveKit, so it would be wired by hand |
| `@timephy/rnnoise-wasm` | RNNoise as WebAssembly | skip: last release August 2024 |
| Krisp / vendor SDKs | commercial | skip unless the quality bar cannot be met, it adds licence cost and a dependency on a vendor |

RNNoise is tiny (a few hundred kilobytes, about 1-3 % of one core) and good against steady noise (fans, hiss,
keyboards). GTCRN is a newer small neural model that is meant to handle more kinds of noise at a similar cost.
Starting with the sapphi-red package lets us compare them on real recordings before committing.

## Phases

0. **Constraints (half a day).** Ask for `{ echoCancellation: true, autoGainControl: true, noiseSuppression: true }`
   explicitly (some browsers default differently), and `voiceIsolation: true` when the browser supports it.
   Add the toggle in the UI already, bound to these constraints.
1. **RNNoise or GTCRN in an AudioWorklet (1-2 days).** The pipeline above. With it on, ask the browser for
   `noiseSuppression: false` so it is not applied twice. Lazy-load the WebAssembly and the worklet only when
   the user turns it on (the service worker precache limit is 5 MB, the files are well below that).
2. **Quality (as needed).** DeepFilterNet3 for desktop and Electron, chosen by a quick CPU benchmark at start.
3. **Smart extras (optional).** A voice activity detector ([`@ricky0123/vad-web`](https://github.com/ricky0123/vad), Silero)
   gives a "you are speaking" ring on the tile and an optional automatic noise gate; a "music mode" that bypasses
   suppression (neural suppressors treat music as noise).
4. **Only if the project adopts an SFU:** server side or SFU-side enhancement, and per-listener volume control.

## Things that can go wrong, and what we do about them

- **AudioWorklet or WebAssembly missing** (old WebView): detect it, use the plain stream with the browser's own
  suppression, and show nothing alarming. Supported by current Chrome, Edge, Safari, Firefox and the Android and iOS
  WebViews Capacitor uses; Electron has it.
- **Sample rate:** RNNoise works at 48 kHz, so the `AudioContext` is created at 48 kHz. Opus already runs at 48 kHz.
- **Autoplay policy:** the `AudioContext` must be resumed from a user gesture; joining a meeting already is one.
- **CPU on weak phones:** measure the time a worklet block takes; if it keeps exceeding its budget, switch the
  suppressor off and tell the user once. Never let suppression cause crackling in the call.
- **Latency:** the graph adds one block (10 ms) plus the output buffer, well under what people notice.
- **Echo:** echo cancellation must stay in the browser, in front of the graph, because only the browser knows what
  is being played back. This is why its constraints stay on.
- **Double suppression and over-suppression:** quiet speakers can be cut. Keep a bypass, keep gain control before
  the suppressor, and expose the choice in the UI.
- **Supply chain:** pin exact versions, serve the WebAssembly from our own origin, and review the licence of each
  model file (RNNoise is BSD-3-Clause, the sapphi-red package is MIT, DeepFilterNet is MIT or Apache-2.0).

## How to test it

- **Unit:** the pipeline's state machine (enable, disable, dispose, fallback) with a fake `AudioContext`.
- **Objective, automatic:** Chrome can play a WAV file as the microphone (`--use-file-for-fake-audio-capture`). Use
  recordings of speech mixed with a fan, keyboard and street noise, run two Edge pages through the existing
  Playwright setup, and compare the *received* audio level (`inbound-rtp` `audioLevel`, or an `AnalyserNode` on the
  remote stream) during the noise-only seconds with suppression off and on. A drop of at least 15 dB in the noise-only
  parts, and no more than 1-2 dB lost in the speech parts, is a reasonable pass mark.
- **Subjective:** a short listening checklist (keyboard, fan, open window, two people talking, music) before the
  feature is switched on by default.
- **Cost:** CPU time per audio block on a mid-range phone and on a laptop, recorded in the test report.

## Decisions needed

1. Default **on** or **off**? Recommendation: on once phase 1 passes the tests above, with the toggle always visible.
2. Is a heavier desktop-only model (phase 2) worth the extra download, or is RNNoise/GTCRN good enough?
3. Should the call mute button keep working as it does today (it mutes the *sent* track), or do you want a separate
   "push to talk" mode built on the voice activity detector?
