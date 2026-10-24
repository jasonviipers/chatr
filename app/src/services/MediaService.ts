import { History } from '../components/withRouter/withRouter';
import { first } from 'lodash';
import routes from '../routes';
import AlertService from './AlertService';
import MeetingService from './MeetingService';
import NoiseSuppressionService from './NoiseSuppressionService';

/**
 * What the microphone is asked for. The browser's echo cancellation and gain control are always on (only the
 * browser knows what is being played back). Its noise suppression is on too, except when our own takes over: a
 * running microphone cannot be switched between the two, and a voice cleaned twice sounds worse.
 */
const microphoneConstraints = (browserSuppression: boolean) => ({
  audio: { echoCancellation: true, autoGainControl: true, noiseSuppression: browserSuppression },
  video: false,
});

export default class MediaService {
  private meetingService: MeetingService;

  constructor() {
    this.meetingService = new MeetingService();
  }

  /**
   * The microphone, cleaned of background noise where that is wanted and possible. When our cleaning cannot start
   * on this device the microphone is opened the way it always was, with the browser's own suppression.
   */
  private async openMicrophone(): Promise<MediaStream> {
    // Must be called on navigator.mediaDevices: the unbound call only worked
    // while webrtc-adapter (via peerjs) replaced it with a pre-bound wrapper.
    const cleaning = await NoiseSuppressionService.willClean();
    const microphone: MediaStream = await navigator.mediaDevices.getUserMedia(
      microphoneConstraints(!cleaning),
    );
    if (!cleaning) return microphone;
    const cleaned = await NoiseSuppressionService.process(microphone);
    if (cleaned !== microphone) return cleaned;
    for (const track of microphone.getTracks()) track.stop();
    return navigator.mediaDevices.getUserMedia(microphoneConstraints(true));
  }

  async getStream(
    history: History,
    callback: (localStream: MediaStream) => void,
  ): Promise<void> {
    try {
      const localStream = await this.openMicrophone();
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
      callback(await this.openMicrophone());
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
