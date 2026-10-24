/** Channels whose id is a meeting id (the host's peer id). The addressed ones (iceRestart, ...) carry a peer id. */
export const MEETING_CHANNEL_KINDS: ReadonlySet<string> = new Set([
  'raiseHand',
  'conferenceCall',
  'remoteDisconnect',
  'memberRemove',
  'rtpTrackReplaced',
  'whiteboardEnabled',
  'whiteboardDrawingAdd',
  'whiteboardCanvasClear',
  'chat',
  'mediaState',
  'meetingLock',
]);

export const LOCKED_MESSAGE = 'This meeting is locked';

export interface MeetingRegistryOptions {
  /** Meetings kept in memory at most (a host that cannot be registered simply cannot lock). */
  maxMeetings?: number;
  /** People remembered per meeting at most. */
  maxMembers?: number;
  /** A meeting nobody has touched for this long is forgotten. */
  idleMs?: number;
  now?: () => number;
}

interface Meeting {
  locked: boolean;
  /** peer ids that were part of the meeting before it was locked (the host is not listed: its id is the meeting) */
  members: Set<string>;
  touchedAt: number;
}

/**
 * Which meetings are locked, and who belongs to them. A meeting is the host's peer id; the host registers it by
 * publishing on its `meetingLock` channel (so only the real owner of the id can do it, see channelAllowed).
 * Until a meeting is registered it is open, as before. While it is open, every identified peer that subscribes to
 * its `mediaState` channel (every participant does) becomes a member; once it is locked nobody new is let in, either
 * on the signalling socket (call set-up) or on the meeting's channels (chat, whiteboard, ...). Members keep working
 * (their socket may reconnect, their call may be dialled again). Unlocking lets everybody in again.
 *
 * Everything is in memory: a restart of the server unlocks every meeting, as it also ends every call set-up.
 */
export class MeetingRegistry {
  private readonly meetings = new Map<string, Meeting>();
  /** peer id -> the meeting it belongs to, so a call to a member of a locked meeting can be refused too */
  private readonly memberOf = new Map<string, string>();
  private readonly maxMeetings: number;
  private readonly maxMembers: number;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(options: MeetingRegistryOptions = {}) {
    this.maxMeetings = options.maxMeetings ?? 10_000;
    this.maxMembers = options.maxMembers ?? 500;
    this.idleMs = options.idleMs ?? 12 * 60 * 60_000;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.meetings.size;
  }

  isLocked(meetingId: string): boolean {
    return this.meetings.get(meetingId)?.locked === true;
  }

  /** Locks or unlocks a meeting (registering it first). False when there is no room for one more meeting. */
  setLocked(meetingId: string, locked: boolean): boolean {
    let meeting = this.meetings.get(meetingId);
    if (!meeting) {
      if (this.meetings.size >= this.maxMeetings) return false;
      meeting = { locked: false, members: new Set(), touchedAt: this.now() };
      this.meetings.set(meetingId, meeting);
    }
    meeting.locked = locked;
    meeting.touchedAt = this.now();
    return true;
  }

  /** An identified peer joins an open, registered meeting. A locked or unknown meeting gains nobody. */
  addMember(meetingId: string, peerId: string): void {
    const meeting = this.meetings.get(meetingId);
    if (!meeting || meeting.locked || peerId === meetingId) return;
    if (meeting.members.has(peerId)) return;
    if (meeting.members.size >= this.maxMembers) return;
    meeting.members.add(peerId);
    meeting.touchedAt = this.now();
    this.memberOf.set(peerId, meetingId);
  }

  /** Somebody left or was removed: they are a newcomer again, so a locked meeting no longer lets them back in. */
  forget(meetingId: string, peerId: string): void {
    this.meetings.get(meetingId)?.members.delete(peerId);
    if (this.memberOf.get(peerId) === meetingId) this.memberOf.delete(peerId);
  }

  /** May this peer (null: not identified) use the meeting's channels right now? */
  admits(meetingId: string, peerId: string | null): boolean {
    const meeting = this.meetings.get(meetingId);
    if (!meeting?.locked) return true;
    return (
      peerId !== null && (peerId === meetingId || meeting.members.has(peerId))
    );
  }

  /** Whether a message from `src` to `dst` must be dropped: `dst` is a locked meeting (or one of its members) and `src` is a stranger. */
  blocks(src: string, dst: string): boolean {
    const direct = this.meetings.get(dst);
    if (direct) return direct.locked && src !== dst && !direct.members.has(src);
    const meetingId = this.memberOf.get(dst);
    const meeting =
      meetingId === undefined ? undefined : this.meetings.get(meetingId);
    return (
      meeting !== undefined &&
      meeting.locked &&
      src !== meetingId &&
      !meeting.members.has(src)
    );
  }

  /** Forgets meetings nobody has touched for a long time. Call now and then. */
  sweep(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [id, meeting] of this.meetings) {
      if (meeting.touchedAt >= cutoff) continue;
      for (const peerId of meeting.members) {
        if (this.memberOf.get(peerId) === id) this.memberOf.delete(peerId);
      }
      this.meetings.delete(id);
    }
  }
}

/** What the server publishes when the host locks or unlocks. Null means "refuse it". */
export function buildMeetingLockPayload(
  from: string | null,
  data: unknown,
): { from: string; locked: boolean } | null {
  if (from === null) return null;
  if (typeof data !== 'object' || data === null) return null;
  const { locked } = data as Record<string, unknown>;
  if (typeof locked !== 'boolean') return null;
  return { from, locked };
}
