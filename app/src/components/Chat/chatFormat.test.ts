import { describe, expect, it } from 'vitest';
import { formatTime, senderHue, senderLabel } from './chatFormat';

describe('senderLabel', () => {
  it('says You for yourself and Host for the host', () => {
    expect(senderLabel('me123', 'me123', 'host99')).toBe('You');
    expect(senderLabel('host99', 'me123', 'host99')).toBe('Host');
  });

  it('is You even when you are the host', () => {
    expect(senderLabel('host99', 'host99', 'host99')).toBe('You');
  });

  it('leaves dashes and underscores out of the tag (ids are base64url)', () => {
    expect(senderLabel('abc_-x9Q-', 'me', 'host')).toBe('Participant CX9Q');
    expect(senderLabel('qwe-12_rt', 'me', 'host')).toBe('Participant 12RT');
  });

  it('uses the name somebody chose, and marks the host', () => {
    const names: Record<string, string> = { guest1: 'Bob Chen', host99: 'Alice' };
    const nameOf = (id: string) => names[id];
    expect(senderLabel('guest1', 'me', 'host99', nameOf)).toBe('Bob Chen');
    expect(senderLabel('host99', 'me', 'host99', nameOf)).toBe('Alice (Host)');
    // a guest who chose no name keeps the short tag, the host who chose none stays "Host"
    expect(senderLabel('abcd-wxyz', 'me', 'host99', nameOf)).toBe('Participant WXYZ');
    expect(senderLabel('host99', 'me', 'host99', () => undefined)).toBe('Host');
    // you are "You" even if you named yourself
    expect(senderLabel('me', 'me', 'host99', () => 'Myself')).toBe('You');
  });

  it('tells guests apart by the end of their id', () => {
    expect(senderLabel('abcd-wxyz', 'me', 'host')).toBe('Participant WXYZ');
    expect(senderLabel('abcd-wxyz', 'me', 'host')).not.toBe(senderLabel('abcd-1234', 'me', 'host'));
  });
});

describe('senderHue', () => {
  it('is stable and within the colour wheel', () => {
    expect(senderHue('peer-1')).toBe(senderHue('peer-1'));
    for (const id of ['a', 'peer-1', 'x'.repeat(40)]) {
      expect(senderHue(id)).toBeGreaterThanOrEqual(0);
      expect(senderHue(id)).toBeLessThan(360);
    }
  });

  it('gives different people different colours (most of the time)', () => {
    expect(senderHue('peer-aaaa')).not.toBe(senderHue('peer-bbbb'));
  });
});

describe('formatTime', () => {
  it('shows hours and minutes', () => {
    expect(formatTime(Date.UTC(2026, 0, 5, 13, 7), 'en-GB')).toMatch(/\d{2}:\d{2}/);
  });
});
