import { cleanDisplayName } from './display-name.ts';

export interface MediaStatePayload {
  /** peer id of the participant, stamped by the server from its verified identity */
  from: string;
  /** the camera is on (a picture is being sent) */
  video: boolean;
  /** the microphone is on (not muted) */
  audio: boolean;
  /** the name the participant chose for this meeting (cleaned); absent when they chose none */
  name?: string;
}

/**
 * What the server publishes when a participant switches the camera or the microphone on or off, and to
 * introduce themselves to people who just connected. The two booleans and the optional name come from the client
 * (the name is cleaned here), who it is comes from the server, so nobody can show another participant as muted,
 * on camera or under a different name. Null means "refuse it".
 */
export function buildMediaStatePayload(
  from: string | null,
  data: unknown,
): MediaStatePayload | null {
  if (from === null) return null;
  if (typeof data !== 'object' || data === null) return null;
  const { video, audio, name } = data as Record<string, unknown>;
  if (typeof video !== 'boolean' || typeof audio !== 'boolean') return null;
  const displayName = cleanDisplayName(name);
  return displayName === null
    ? { from, video, audio }
    : { from, video, audio, name: displayName };
}
