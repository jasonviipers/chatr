/** Longest display name, in characters (the app's input enforces the same number). */
export const DISPLAY_NAME_MAX_LENGTH = 40;

// Names that would pass for the labels the app puts on a tile by itself
const RESERVED = new Set(['you', 'host']);

// What a person cannot see but that is enough to make two names look the same, to hide one or to make text read
// backwards: C0/C1 control characters, the soft hyphen, zero-width characters, bidirectional overrides and isolates,
// the byte order mark. As code point ranges (not a pattern) so no tool can rewrite them into invisible characters.
const INVISIBLE: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];
// line breaks and tabs are spaces, not nothing
const SPACES = new Set([0x09, 0x0a, 0x0d, 0x2028, 0x2029]);

const isInvisible = (codePoint: number) =>
  INVISIBLE.some(([from, to]) => codePoint >= from && codePoint <= to);

/**
 * The name to show for a participant, or null when there is none (nothing typed, or nothing a person could read,
 * or a word the app uses for its own labels). Longer names are cut rather than refused.
 */
export function cleanDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const visible = [...value.normalize('NFC')]
    .map((char) => (SPACES.has(char.codePointAt(0) ?? 0) ? ' ' : char))
    .filter((char) => !isInvisible(char.codePointAt(0) ?? 0))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  // cut by characters, not by UTF-16 units, so an emoji is never split in half
  const name = [...visible].slice(0, DISPLAY_NAME_MAX_LENGTH).join('').trim();
  if (name.length === 0 || RESERVED.has(name.toLowerCase())) return null;
  return name;
}
