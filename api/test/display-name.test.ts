import { describe, expect, it } from 'vitest';
import {
  cleanDisplayName,
  DISPLAY_NAME_MAX_LENGTH,
} from '../src/realtime/display-name.ts';
import { buildMediaStatePayload } from '../src/realtime/media-state.ts';

// invisible characters are written as code points, so they stay visible in this file
const ch = (codePoint: number) => String.fromCodePoint(codePoint);
const ZERO_WIDTH_SPACE = ch(0x200b);
const RIGHT_TO_LEFT_OVERRIDE = ch(0x202e);
const SOFT_HYPHEN = ch(0x00ad);
const NUL = ch(0x0000);
const BELL = ch(0x0007);
const GRINNING_FACE = ch(0x1f600);

describe('cleanDisplayName', () => {
  it('keeps a normal name, with spaces tidied up', () => {
    expect(cleanDisplayName('Alice Martin')).toBe('Alice Martin');
    expect(cleanDisplayName('  Bob \t  Chen \n')).toBe('Bob Chen');
    expect(cleanDisplayName('Zoë 王芳 🎙️')).toBe('Zoë 王芳 🎙️');
  });

  it('has no name for nothing, for non-text and for text that shows nothing', () => {
    for (const value of [
      '',
      '   ',
      '\n\t',
      ZERO_WIDTH_SPACE.repeat(2),
      RIGHT_TO_LEFT_OVERRIDE,
      undefined,
      null,
      12,
      {},
      ['a'],
    ])
      expect(cleanDisplayName(value)).toBeNull();
  });

  it('removes characters that hide or reverse text', () => {
    expect(cleanDisplayName(`Al${ZERO_WIDTH_SPACE}ice`)).toBe('Alice');
    expect(cleanDisplayName(`${RIGHT_TO_LEFT_OVERRIDE}evil`)).toBe('evil');
    expect(cleanDisplayName(`a${NUL}b${BELL}c`)).toBe('abc');
    expect(cleanDisplayName(`soft${SOFT_HYPHEN}hyphen`)).toBe('softhyphen');
  });

  it('treats line breaks and tabs as spaces', () => {
    expect(cleanDisplayName(`Ann${ch(0x2028)}Lee`)).toBe('Ann Lee');
    expect(cleanDisplayName('Ann\r\nLee')).toBe('Ann Lee');
  });

  it('cuts long names by characters and never splits an emoji', () => {
    const long = cleanDisplayName('x'.repeat(100))!;
    expect([...long]).toHaveLength(DISPLAY_NAME_MAX_LENGTH);
    const emojis = cleanDisplayName(GRINNING_FACE.repeat(60))!;
    expect([...emojis]).toHaveLength(DISPLAY_NAME_MAX_LENGTH);
    expect(emojis).toBe(GRINNING_FACE.repeat(DISPLAY_NAME_MAX_LENGTH));
  });

  it('does not let a guest pass for the labels the app writes itself', () => {
    for (const value of ['Host', 'host', ' HOST ', 'You', 'you'])
      expect(cleanDisplayName(value)).toBeNull();
    expect(cleanDisplayName('Hostess')).toBe('Hostess');
    expect(cleanDisplayName('Your Honour')).toBe('Your Honour');
  });
});

describe('buildMediaStatePayload with a name', () => {
  it('adds the cleaned name, and the identity still comes from the server', () => {
    expect(
      buildMediaStatePayload('peerAAA123', {
        video: false,
        audio: true,
        name: '  Alice  ',
        from: 'forged',
      }),
    ).toEqual({ from: 'peerAAA123', video: false, audio: true, name: 'Alice' });
  });

  it('leaves the name out when there is none worth showing, and still takes the switches', () => {
    for (const name of [undefined, '', '   ', 'Host', 7, null])
      expect(
        buildMediaStatePayload('p', { video: true, audio: true, name }),
      ).toEqual({ from: 'p', video: true, audio: true });
  });
});
