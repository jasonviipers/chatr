import store from '../store';
import { actions as meetingActions } from '../pages/Meeting/Meeting.state';
import socket from '../pages/Meeting/Meeting.socket';
import MeetingRepository from '../repositories/MeetingRepository';
import { hasPicture } from '../components/Video/AudioOnly';
import MeetingService from './MeetingService';

export interface MediaState {
  /** a picture is being sent (the camera, or a shared screen) */
  video: boolean;
  /** the microphone is not muted */
  audio: boolean;
}

/** What the server publishes (see api/src/realtime/media-state.ts). */
export interface MediaStatePayload extends MediaState {
  from: string;
}

/**
 * Who has the camera and the microphone on. The picture and the sound travel in the call, but "this person
 * switched their camera off" or "they muted themselves" is not visible in it (a muted track still arrives, as
 * silence or black), so every participant announces their own state and everybody else shows it.
 */
const known = new Map<string, MediaState>();

export default class MediaStateService {
  private readonly meetingService = new MeetingService();
  private readonly meetingRepository = new MeetingRepository();

  /** What was last announced for a participant (a tile that appears later starts from it). */
  stateOf(id: string): MediaState | undefined {
    return known.get(id);
  }

  /** An announcement from somebody else. */
  receive(payload: MediaStatePayload): void {
    if (payload.from === this.meetingService.getConnectionId()) return;
    known.set(payload.from, { video: payload.video, audio: payload.audio });
    store.dispatch(meetingActions.replaceVideoStreamMutedVideo(payload.from, !payload.video));
    store.dispatch(meetingActions.replaceVideoStreamMutedAudio(payload.from, !payload.audio));
  }

  /** Announces our own state: after switching the camera or the microphone, and to people who just connected. */
  publishOwn(): void {
    const video = this.meetingRepository.getUserVideo();
    if (!video) return;
    socket.mediaState.publish(this.meetingService.getMeetingId(), {
      video: hasPicture(video),
      audio: !video.streamMuted.audio,
    });
  }

  clear(): void {
    known.clear();
  }
}
