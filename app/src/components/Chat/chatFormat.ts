/**
 * Who a chat message is from, in words: the name the sender chose for the meeting, if any. Otherwise the last
 * characters of the id tell guests apart (meetings are anonymous). The host is marked as such either way.
 */
export function senderLabel(
  from: string,
  myId: string,
  hostId: string,
  nameOf?: (id: string) => string | undefined,
): string {
  if (from === myId) return 'You';
  const name = nameOf?.(from);
  if (name) return from === hostId ? `${name} (Host)` : name;
  if (from === hostId) return 'Host';
  // ids are base64url: keep letters and digits so the tag reads cleanly (not "Participant -10K")
  return `Participant ${from.replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase()}`;
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
