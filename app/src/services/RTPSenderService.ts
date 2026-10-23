import { find, forEach } from 'lodash';
import MeetingSocket from '../pages/Meeting/Meeting.socket';
import MeetingService from './MeetingService';
import MeetingRepository from '../repositories/MeetingRepository';
import { pictureOf, setVideoTrack, videoSenderOf } from './OutgoingMedia';

export default class RTPSenderService {
  private meetingService: MeetingService;

  private meetingRepository: MeetingRepository;

  constructor() {
    this.meetingService = new MeetingService();
    this.meetingRepository = new MeetingRepository();
  }

  private publishRTCTrackReplacedSocket() {
    const meetingId = this.meetingService.getMeetingId();
    const connectionId = this.meetingService.getConnectionId();
    const video = this.meetingRepository.getVideo(connectionId);
    if (video) {
      const payload = { connectionId, kind: video.kind };
      MeetingSocket.rtpTrackReplaced.publish(meetingId, payload);
    }
  }

  /** The calls that are still running. */
  private connections(): RTCPeerConnection[] {
    return this.meetingService
      .getCalls()
      .map((call) => call.peerConnection)
      .filter((connection): connection is RTCPeerConnection => Boolean(connection));
  }

  /** Sends the audio and the picture of `stream` (screen sharing starting, or stopping again) on every call. */
  replaceStream(stream: MediaStream) {
    const audioTrack = find(stream.getAudioTracks());
    forEach(this.connections(), (connection) => {
      const audioSender = find(connection.getSenders(), ({ track }) => track?.kind === 'audio');
      if (audioSender && audioTrack) audioSender.replaceTrack(audioTrack);
      // a stream without a picture (back to voice only) empties the video line instead of leaving the old picture on it
      void setVideoTrack(connection, pictureOf(stream));
    });
    this.publishRTCTrackReplacedSocket();
  }

  /** Puts the camera on the video line of every call, or takes it off (null). */
  setVideoTrack(track: MediaStreamTrack | null) {
    forEach(this.connections(), (connection) => void setVideoTrack(connection, track));
  }

  /** Whether every call has a video line to put a picture on (calls made before this existed have none). */
  get hasVideoLines(): boolean {
    return this.connections().every((connection) => videoSenderOf(connection) !== undefined);
  }
}
