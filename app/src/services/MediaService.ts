import { History } from '../components/withRouter/withRouter';
import { first } from 'lodash';
import routes from '../routes';
import AlertService from './AlertService';
import MeetingService from './MeetingService';

export default class MediaService {
  private meetingService: MeetingService;

  constructor() {
    this.meetingService = new MeetingService();
  }

  async getStream(
    history: History,
    callback: (localStream: MediaStream) => void,
  ): Promise<void> {
    try {
      // Must be called on navigator.mediaDevices: the unbound call only worked
      // while webrtc-adapter (via peerjs) replaced it with a pre-bound wrapper.
      const constraints = { audio: true, video: false };
      const localStream: MediaStream =
        await navigator.mediaDevices.getUserMedia(constraints);
      this.meetingService.setMediaStream(localStream);
      callback(localStream);
    } catch {
      AlertService.push('Requested device is not available');
      history.push(routes.home.path);
    }
  }

  async getAudioStream(
    callback: (audioStream: MediaStream) => void,
  ): Promise<void> {
    try {
      const constraints = { audio: true, video: false };
      const audioStream: MediaStream =
        await navigator.mediaDevices.getUserMedia(constraints);
      callback(audioStream);
    } catch {
      AlertService.push("Device doesn't support audio capture");
    }
  }

  toggleVideoMute(stream: MediaStream) {
    const track = first(stream.getVideoTracks());
    if (track) track.enabled = !track.enabled;
    return track ? track.enabled : false;
  }

  toggleAudioMute(stream: MediaStream) {
    const track = first(stream.getAudioTracks());
    if (track) track.enabled = !track.enabled;
    return track ? track.enabled : false;
  }
}
