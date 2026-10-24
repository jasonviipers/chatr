import StorageService from './StorageService';

/** Longest display name, in characters (the API cuts at the same number). */
export const DISPLAY_NAME_MAX_LENGTH = 40;

const STORAGE_KEY = 'displayName';

// Words the app puts on a tile by itself
const RESERVED = new Set(['you', 'host']);

// What a person cannot see but that is enough to make two names look the same, to hide one or to make text read
// backwards (control characters, soft hyphen, zero-width characters, bidirectional overrides, byte order mark).
// Code point ranges, as on the server (api/src/realtime/display-name.ts).
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
const SPACES = new Set([0x09, 0x0a, 0x0d, 0x2028, 0x2029]);

const codePointOf = (char: string) => char.codePointAt(0) ?? 0;

/** The name as it will be shown to the others: tidy, visible, not longer than allowed. Empty means "no name". */
export function cleanDisplayName(value: string): string {
  const visible = [...value.normalize('NFC')]
    .map((char) => (SPACES.has(codePointOf(char)) ? ' ' : char))
    .filter((char) => !INVISIBLE.some(([from, to]) => codePointOf(char) >= from && codePointOf(char) <= to))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const name = [...visible].slice(0, DISPLAY_NAME_MAX_LENGTH).join('').trim();
  return RESERVED.has(name.toLowerCase()) ? '' : name;
}

/**
 * The name the person wants to be shown under in meetings. It is optional, it is remembered on this device (in
 * the browser's own storage, never sent to the server except as part of a meeting) and the others in a meeting
 * receive it together with the state of the microphone and the camera.
 */
export default class DisplayNameService {
  private static name = '';
  private static storage = new StorageService();

  /** What is known right now (loaded from the device by `load`). */
  static current(): string {
    return DisplayNameService.name;
  }

  static async load(): Promise<string> {
    try {
      const stored = await DisplayNameService.storage.get(STORAGE_KEY);
      if (typeof stored === 'string' && DisplayNameService.name === '') DisplayNameService.name = cleanDisplayName(stored);
    } catch {
      // storage unavailable (private mode, blocked): the name just is not remembered
    }
    return DisplayNameService.name;
  }

  /** What is being typed: used at once, and remembered (without the clean-up, so typing a space is not eaten). */
  static set(raw: string): void {
    DisplayNameService.name = cleanDisplayName(raw);
    const remember = raw.trim().length === 0 ? DisplayNameService.storage.remove(STORAGE_KEY) : DisplayNameService.storage.set(STORAGE_KEY, DisplayNameService.name);
    remember.catch(() => undefined);
  }
}
