/** Who a chat message is from, in words. Meetings are anonymous, so the last characters of the id tell guests apart. */
export function senderLabel(from: string, myId: string, hostId: string): string {
  if (from === myId) return 'You';
  if (from === hostId) return 'Host';
  return `Participant ${from.slice(-4).toUpperCase()}`;
}

/** A stable, readable colour for a sender (the same person always gets the same one). */
export function senderHue(from: string): number {
  let hash = 0;
  for (const char of from) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function formatTime(at: number, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}
