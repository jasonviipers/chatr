/**
 * The camera. Chatr meetings start with voice only; the camera is asked for when the user switches it on, and
 * released (the light goes off) when they switch it off or leave.
 *
 * A modest picture on purpose: every participant sends it to everybody else (a mesh), so the uplink is
 * what runs out first. The call adapts it further to the link (see network/NetworkMonitor).
 */
export default class CameraService {
  private track: MediaStreamTrack | null = null;
  private endedHandler: (() => void) | null = null;

  /** Whether a live camera track is running. */
  get isOn(): boolean {
    return this.track !== null && this.track.readyState === 'live';
  }

  get currentTrack(): MediaStreamTrack | null {
    return this.isOn ? this.track : null;
  }

  /** Told when the camera stops by itself (unplugged, or the permission was withdrawn). */
  onEnded(handler: () => void): void {
    this.endedHandler = handler;
  }

  /** Asks for the camera; throws when it is not available or the user said no. */
  async turnOn(): Promise<MediaStreamTrack> {
    if (this.currentTrack) return this.currentTrack;
    // Must be called on navigator.mediaDevices (see MediaService)
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('no video track');
    track.contentHint = 'motion'; // a person talking: smooth beats sharp (a shared screen is the other way round)
    track.addEventListener('ended', () => {
      if (this.track !== track) return;
      this.track = null;
      this.endedHandler?.();
    });
    this.track = track;
    return track;
  }

  /** Releases the camera. */
  turnOff(): void {
    const track = this.track;
    this.track = null;
    track?.stop();
  }
}

/** One camera per tab. */
export const camera = new CameraService();
