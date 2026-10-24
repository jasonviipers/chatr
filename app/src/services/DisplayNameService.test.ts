import { describe, expect, it } from 'vitest';
import { cleanDisplayName, DISPLAY_NAME_MAX_LENGTH } from './DisplayNameService';

// invisible characters are written as code points, so they stay visible in this file
const ch = (codePoint: number) => String.fromCodePoint(codePoint);

describe('cleanDisplayName', () => {
  it('keeps a normal name and tidies the spaces', () => {
    expect(cleanDisplayName('Alice Martin')).toBe('Alice Martin');
    expect(cleanDisplayName('  Bob \t Chen \n')).toBe('Bob Chen');
    expect(cleanDisplayName('Zoë 王芳')).toBe('Zoë 王芳');
  });

  it('is empty (no name) for nothing, for invisible text and for the words the app uses itself', () => {
    for (const value of ['', '   ', ch(0x200b).repeat(3), ch(0x202e), 'Host', 'host', ' YOU '])
      expect(cleanDisplayName(value)).toBe('');
  });

  it('removes characters that hide or reverse text', () => {
    expect(cleanDisplayName(`Al${ch(0x200b)}ice`)).toBe('Alice');
    expect(cleanDisplayName(`${ch(0x202e)}evil`)).toBe('evil');
    expect(cleanDisplayName(`a${ch(0)}b${ch(7)}c`)).toBe('abc');
  });

  it('cuts at the limit by characters, never in the middle of an emoji', () => {
    expect([...cleanDisplayName('x'.repeat(100))]).toHaveLength(DISPLAY_NAME_MAX_LENGTH);
    const face = ch(0x1f600);
    expect(cleanDisplayName(face.repeat(60))).toBe(face.repeat(DISPLAY_NAME_MAX_LENGTH));
  });

  it('agrees with the server about the limit', () => {
    expect(DISPLAY_NAME_MAX_LENGTH).toBe(40); // api/src/realtime/display-name.ts
  });
});
