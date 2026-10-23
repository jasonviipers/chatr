import { describe, expect, it } from 'vitest';
import { optimiseOpus } from './opus';
import { PROFILES, QualityController, classify, summarizeStats } from './QualityController';

const good = { loss: 0, rttMs: 40, jitterMs: 5 };
const fair = { loss: 0.03, rttMs: 150, jitterMs: 10 };
const poor = { loss: 0.09, rttMs: 300, jitterMs: 20 };
const critical = { loss: 0.3, rttMs: 900, jitterMs: 150 };

describe('classify', () => {
  it('maps loss, delay and jitter onto four levels', () => {
    expect(classify(good)).toBe(0);
    expect(classify(fair)).toBe(1);
    expect(classify(poor)).toBe(2);
    expect(classify(critical)).toBe(3);
    expect(classify({ loss: 0, rttMs: 450, jitterMs: 0 })).toBe(2); // delay alone is enough
    expect(classify({ loss: 0, rttMs: 0, jitterMs: 130 })).toBe(3); // so is jitter
  });
});

describe('QualityController', () => {
  it('stays put on a healthy link', () => {
    const controller = new QualityController();
    for (let n = 0; n < 20; n++) expect(controller.push(good).changed).toBe(false);
    expect(controller.level).toBe(0);
  });

  it('degrades after two bad samples in one jump, not on a single glitch', () => {
    const controller = new QualityController({ smoothing: 1 }); // no averaging: easier to reason about
    expect(controller.push(critical)).toEqual({ level: 0, changed: false }); // one glitch
    controller.push(good);
    expect(controller.push(critical).changed).toBe(false); // still not two in a row
    expect(controller.push(critical)).toEqual({ level: 3, changed: true });
  });

  it('recovers one level at a time and only after a sustained improvement', () => {
    const controller = new QualityController({ smoothing: 1 });
    controller.push(critical);
    controller.push(critical);
    expect(controller.level).toBe(3);

    const levels: number[] = [];
    for (let n = 0; n < 24; n++) levels.push(controller.push(good).level);
    expect(levels.slice(0, 7).every((level) => level === 3)).toBe(true);
    expect(levels[7]).toBe(2); // 8 good samples: one step up
    expect(levels[15]).toBe(1);
    expect(levels[23]).toBe(0);
  });

  it('does not flap when the link oscillates', () => {
    const controller = new QualityController({ smoothing: 1 });
    let changes = 0;
    for (let n = 0; n < 40; n++) if (controller.push(n % 2 === 0 ? poor : good).changed) changes++;
    expect(changes).toBe(0); // never two consecutive bad samples, never eight good ones
  });

  it('smooths spikes with the moving average', () => {
    const controller = new QualityController({ smoothing: 0.2, degradeAfter: 2 });
    for (let n = 0; n < 10; n++) controller.push(good);
    controller.push(critical);
    controller.push(critical);
    expect(controller.level).toBeLessThan(3); // two spikes after a long calm stretch only nudge the average
  });
});

describe('profiles', () => {
  it('gives voice priority: screen sharing degrades first and is paused last, audio keeps flowing', () => {
    expect(PROFILES[0].screenMaxBitrate).toBeGreaterThan(PROFILES[1].screenMaxBitrate);
    expect(PROFILES[1].screenMaxBitrate).toBeGreaterThan(PROFILES[2].screenMaxBitrate);
    expect(PROFILES[3].screenActive).toBe(false);
    for (const level of [0, 1, 2, 3] as const) expect(PROFILES[level].audioMaxBitrate).toBeGreaterThanOrEqual(8_000);
    expect(PROFILES[0].audioMaxBitrate).toBeGreaterThan(PROFILES[3].audioMaxBitrate);
  });
});

describe('summarizeStats', () => {
  it('reads loss, delay and jitter as the remote side reports them', () => {
    const sample = summarizeStats([
      { type: 'remote-inbound-rtp', kind: 'audio', fractionLost: 0.05, roundTripTime: 0.12, jitter: 0.02 },
      { type: 'remote-inbound-rtp', kind: 'video', fractionLost: 0.01, roundTripTime: 0.3, jitter: 0.01 },
      { type: 'inbound-rtp', packetsLost: 999 },
    ]);
    expect(sample).toEqual({ loss: 0.05, rttMs: 300, jitterMs: 20 }); // worst of each
  });

  it('falls back to the transport round-trip time and returns null with nothing to measure', () => {
    expect(summarizeStats([{ type: 'candidate-pair', nominated: true, state: 'succeeded', currentRoundTripTime: 0.08 }])).toEqual({ loss: 0, rttMs: 80, jitterMs: 0 });
    expect(summarizeStats([{ type: 'transport' }])).toBeNull();
  });
});

describe('optimiseOpus', () => {
  const sdp = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9', 'a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=0', 'a=rtpmap:9 G722/8000', ''].join('\r\n');

  it('turns on in-band FEC and DTX and keeps the line endings', () => {
    const result = optimiseOpus(sdp);
    const fmtp = result.split('\r\n').find((line) => line.startsWith('a=fmtp:111'))!;
    expect(fmtp).toContain('useinbandfec=1');
    expect(fmtp).toContain('usedtx=1');
    expect(fmtp).toContain('stereo=0');
    expect(fmtp).not.toContain('useinbandfec=0');
    expect(result.includes('\r\n')).toBe(true);
    expect(result).toContain('a=rtpmap:9 G722/8000'); // other codecs untouched
  });

  it('adds an fmtp line when the offer has none, and ignores SDP without opus', () => {
    const bare = ['m=audio 9 RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', ''].join('\n');
    expect(optimiseOpus(bare)).toContain('a=fmtp:111 useinbandfec=1;usedtx=1');
    const noOpus = 'm=audio 9 RTP/SAVPF 0\na=rtpmap:0 PCMU/8000\n';
    expect(optimiseOpus(noOpus)).toBe(noOpus);
  });
});
