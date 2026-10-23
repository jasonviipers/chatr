export interface MediaStatePayload {
  /** peer id of the participant, stamped by the server from its verified identity */
  from: string;
  /** the camera is on (a picture is being sent) */
  video: boolean;
  /** the microphone is on (not muted) */
  audio: boolean;
}

/**
 * What the server publishes when a participant switches the camera or the microphone on or off. Only the two
 * booleans come from the client; who it is comes from the server, so nobody can show another participant as
 * muted or on camera. Null means "refuse it".
 */
export function buildMediaStatePayload(
  from: string | null,
  data: unknown,
): MediaStatePayload | null {
  if (from === null) return null;
  if (typeof data !== 'object' || data === null) return null;
  const { video, audio } = data as Record<string, unknown>;
  if (typeof video !== 'boolean' || typeof audio !== 'boolean') return null;
  return { from, video, audio };
}
