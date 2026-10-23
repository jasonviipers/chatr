/**
 * Makes the Opus voice codec robust on lossy links by editing the SDP before it is sent:
 *  - in-band FEC (`useinbandfec=1`): each packet carries a low-rate copy of the previous one, so a single
 *    lost packet is rebuilt instead of heard as a gap;
 *  - DTX (`usedtx=1`): silence costs almost no bandwidth, which leaves room for the speech;
 *  - mono, 32 kbps ceiling, 10 ms minimum packetisation: plenty for voice and cheap to deliver.
 */
const WANTED: Record<string, string> = {
  useinbandfec: '1',
  usedtx: '1',
  stereo: '0',
  'sprop-stereo': '0',
  maxaveragebitrate: '32000',
  minptime: '10',
};

export function optimiseOpus(sdp: string): string {
  const lineBreak = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(lineBreak);

  const payloadTypes = new Set<string>();
  for (const line of lines) {
    const match = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
    if (match?.[1]) payloadTypes.add(match[1]);
  }
  if (payloadTypes.size === 0) return sdp;

  const result: string[] = [];
  const handled = new Set<string>();

  for (const line of lines) {
    const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (fmtp?.[1] && payloadTypes.has(fmtp[1])) {
      const parameters = new Map<string, string>();
      for (const part of (fmtp[2] ?? '').split(';')) {
        const [key, value] = part.split('=');
        if (key?.trim()) parameters.set(key.trim(), (value ?? '').trim());
      }
      for (const [key, value] of Object.entries(WANTED)) parameters.set(key, value);
      result.push(`a=fmtp:${fmtp[1]} ${[...parameters].map(([key, value]) => (value === '' ? key : `${key}=${value}`)).join(';')}`);
      handled.add(fmtp[1]);
      continue;
    }
    result.push(line);

    // an opus rtpmap without an fmtp line: add one right after it
    const rtpmap = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
    if (rtpmap?.[1] && !lines.some((candidate) => candidate.startsWith(`a=fmtp:${rtpmap[1]} `))) {
      result.push(`a=fmtp:${rtpmap[1]} ${Object.entries(WANTED).map(([key, value]) => `${key}=${value}`).join(';')}`);
      handled.add(rtpmap[1]);
    }
  }
  return result.join(lineBreak);
}
