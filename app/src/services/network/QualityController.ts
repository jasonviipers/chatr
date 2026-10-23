/**
 * Decides how hard to push a call, from measurements of the link.
 *
 * The rule of thumb on a bad connection: audio must always get through, so everything else gives way
 * first. As the link gets worse the controller (1) lowers the audio bitrate a little (smaller packets,
 * fewer losses, FEC covers the rest), (2) squeezes screen sharing (lower bitrate, resolution, frame rate)
 * and finally (3) pauses screen sharing so all the bandwidth left goes to voice.
 *
 * It reacts quickly when things get worse (2 samples) and recovers slowly, one step at a time
 * (8 samples), so a flaky link does not make quality flap up and down.
 */

/** 0 good, 1 fair, 2 poor, 3 critical */
export type QualityLevel = 0 | 1 | 2 | 3;

export interface LinkSample {
  /** fraction of packets lost, 0..1 */
  loss: number;
  rttMs: number;
  jitterMs: number;
}

export interface QualityProfile {
  audioMaxBitrate: number;
  screenActive: boolean;
  screenMaxBitrate: number;
  screenScaleDown: number;
  screenMaxFps: number;
}

export const PROFILES: Readonly<Record<QualityLevel, QualityProfile>> = {
  0: { audioMaxBitrate: 32_000, screenActive: true, screenMaxBitrate: 2_500_000, screenScaleDown: 1, screenMaxFps: 30 },
  1: { audioMaxBitrate: 24_000, screenActive: true, screenMaxBitrate: 1_000_000, screenScaleDown: 1.5, screenMaxFps: 24 },
  2: { audioMaxBitrate: 16_000, screenActive: true, screenMaxBitrate: 350_000, screenScaleDown: 2, screenMaxFps: 12 },
  3: { audioMaxBitrate: 10_000, screenActive: false, screenMaxBitrate: 0, screenScaleDown: 4, screenMaxFps: 5 },
};

/** Thresholds (smoothed values) at which each level starts. */
const THRESHOLDS: readonly { level: QualityLevel; loss: number; rttMs: number; jitterMs: number }[] = [
  { level: 3, loss: 0.15, rttMs: 800, jitterMs: 120 },
  { level: 2, loss: 0.07, rttMs: 400, jitterMs: 60 },
  { level: 1, loss: 0.02, rttMs: 200, jitterMs: 30 },
];

export function classify(sample: LinkSample): QualityLevel {
  for (const t of THRESHOLDS) {
    if (sample.loss >= t.loss || sample.rttMs >= t.rttMs || sample.jitterMs >= t.jitterMs) return t.level;
  }
  return 0;
}

export interface QualityControllerOptions {
  /** weight of the newest sample in the moving average */
  smoothing?: number;
  degradeAfter?: number;
  upgradeAfter?: number;
}

export class QualityController {
  private readonly smoothing: number;
  private readonly degradeAfter: number;
  private readonly upgradeAfter: number;

  private smoothed: LinkSample | null = null;
  private current: QualityLevel = 0;
  private worseStreak = 0;
  private betterStreak = 0;

  constructor(options: QualityControllerOptions = {}) {
    this.smoothing = options.smoothing ?? 0.4;
    this.degradeAfter = options.degradeAfter ?? 2;
    this.upgradeAfter = options.upgradeAfter ?? 8;
  }

  get level(): QualityLevel {
    return this.current;
  }

  /** Feed one measurement; returns the (possibly new) level. */
  push(sample: LinkSample): { level: QualityLevel; changed: boolean } {
    const a = this.smoothing;
    this.smoothed =
      this.smoothed === null
        ? { ...sample }
        : {
            loss: a * sample.loss + (1 - a) * this.smoothed.loss,
            rttMs: a * sample.rttMs + (1 - a) * this.smoothed.rttMs,
            jitterMs: a * sample.jitterMs + (1 - a) * this.smoothed.jitterMs,
          };

    const target = classify(this.smoothed);
    const before = this.current;

    if (target > this.current) {
      this.betterStreak = 0;
      if (++this.worseStreak >= this.degradeAfter) {
        this.current = target; // a worsening link is acted on in one jump
        this.worseStreak = 0;
      }
    } else if (target < this.current) {
      this.worseStreak = 0;
      if (++this.betterStreak >= this.upgradeAfter) {
        this.current = (this.current - 1) as QualityLevel; // recovery is cautious: one step at a time
        this.betterStreak = 0;
      }
    } else {
      this.worseStreak = 0;
      this.betterStreak = 0;
    }

    return { level: this.current, changed: this.current !== before };
  }
}

/**
 * Reads the numbers that matter out of an RTCStatsReport: what the *other side* reports about our
 * outgoing media (loss, jitter, round-trip time) plus the transport's own round-trip estimate.
 * Returns null while there is nothing to measure yet.
 */
export function summarizeStats(report: Iterable<Record<string, any>>): LinkSample | null {
  let loss: number | null = null;
  let rtt: number | null = null;
  let jitter: number | null = null;
  let pairRtt: number | null = null;

  for (const stat of report) {
    if (stat['type'] === 'remote-inbound-rtp') {
      if (typeof stat['fractionLost'] === 'number') loss = Math.max(loss ?? 0, stat['fractionLost']);
      if (typeof stat['roundTripTime'] === 'number') rtt = Math.max(rtt ?? 0, stat['roundTripTime'] * 1000);
      if (typeof stat['jitter'] === 'number') jitter = Math.max(jitter ?? 0, stat['jitter'] * 1000);
    } else if (stat['type'] === 'candidate-pair' && stat['nominated'] === true && stat['state'] === 'succeeded') {
      if (typeof stat['currentRoundTripTime'] === 'number') pairRtt = stat['currentRoundTripTime'] * 1000;
    }
  }

  const measuredRtt = rtt ?? pairRtt;
  if (loss === null && measuredRtt === null) return null;
  return { loss: loss ?? 0, rttMs: measuredRtt ?? 0, jitterMs: jitter ?? 0 };
}
