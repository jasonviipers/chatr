/** Longest chat message, in UTF-16 units (the app's input enforces the same number). */
export const CHAT_MAX_LENGTH = 1000;

export interface ChatPayload {
  /** chosen by the sender, lets it match its own message when it comes back */
  id: string;
  text: string;
  /** peer id of the sender, stamped by the server from its verified identity */
  from: string;
  /** server time (ms), so every participant orders messages by the same clock */
  at: number;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{6,40}$/;
// C0/C1 control characters except newline, and the bidirectional overrides that make text read backwards
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/g;

/** The text to show, or null when there is nothing (or too much) to say. */
export function cleanChatText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length === 0 || text.length > CHAT_MAX_LENGTH) return null;
  return text;
}

/**
 * What the server publishes for a chat message: only the sender's `id` and `text` are taken from the
 * client, who the sender is and when it was sent come from the server. Null means "refuse it".
 */
export function buildChatPayload(
  from: string | null,
  data: unknown,
  now: number = Date.now(),
): ChatPayload | null {
  if (from === null) return null;
  if (typeof data !== 'object' || data === null) return null;
  const { id, text } = data as Record<string, unknown>;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
  const clean = cleanChatText(text);
  if (clean === null) return null;
  return { id, text: clean, from, at: now };
}
