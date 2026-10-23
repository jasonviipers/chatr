/**
 * Every call carries a video line from the start, even while nobody has a camera on.
 *
 * Changing the lines of a running call means renegotiating it, and PeerJS cannot do that. Swapping the track
 * on a line that already exists does not (`RTCRtpSender.replaceTrack`), so the camera and screen sharing can be
 * switched on and off in the middle of a call without any signalling. The line is opened with a placeholder
 * track, and as soon as the call is negotiated the placeholder is taken off: with nothing on the line nothing
 * is sent (no bandwidth, no black picture).
 */

let placeholder: MediaStreamTrack | null = null;

/** A 16 x 16 black picture. It exists only so that the video line is negotiated; it is never shown. */
export function placeholderTrack(): MediaStreamTrack {
  if (placeholder && placeholder.readyState === 'live') return placeholder;
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#000000';
    context.fillRect(0, 0, 16, 16);
  }
  const track = canvas.captureStream(1).getVideoTracks()[0];
  if (!track) throw new Error('cannot create a placeholder video track');
  placeholder = track;
  return track;
}

export function isPlaceholder(track: MediaStreamTrack | null): boolean {
  return track !== null && track === placeholder;
}

/** The live picture of a stream, if it has one (a camera or a shared screen). */
export function pictureOf(stream: MediaStream): MediaStreamTrack | null {
  return stream.getVideoTracks().find((track) => track.readyState === 'live') ?? null;
}

/** What to hand to a new call: the audio of `source`, and its picture or else the placeholder. */
export function callStream(source: MediaStream): MediaStream {
  return new MediaStream([...source.getAudioTracks(), pictureOf(source) ?? placeholderTrack()]);
}

/** The sender of a call's video line (found through the transceivers: its track may be empty). */
export function videoSenderOf(connection: RTCPeerConnection): RTCRtpSender | undefined {
  return connection.getTransceivers().find((transceiver) => transceiver.receiver.track.kind === 'video')?.sender;
}

/** Runs `action` once the call has been negotiated (an offer and its answer have both been applied). */
export function whenNegotiated(connection: RTCPeerConnection, action: () => void): void {
  const ready = () => connection.signalingState === 'stable' && connection.remoteDescription !== null && connection.localDescription !== null;
  if (ready()) return action();
  const listener = () => {
    if (!ready()) return;
    connection.removeEventListener('signalingstatechange', listener);
    action();
  };
  connection.addEventListener('signalingstatechange', listener);
}

/** Puts `track` (or nothing) on the video line of a call, without renegotiating. */
export async function setVideoTrack(connection: RTCPeerConnection, track: MediaStreamTrack | null): Promise<void> {
  const sender = videoSenderOf(connection);
  if (!sender || sender.track === track) return;
  try {
    await sender.replaceTrack(track);
  } catch {
    // the call is closing: nothing to do
  }
}

/** After a call is negotiated: send what is meant to be sent right now (usually nothing, the placeholder goes). */
export function settleCall(connection: RTCPeerConnection, desired: () => MediaStreamTrack | null): void {
  whenNegotiated(connection, () => void setVideoTrack(connection, desired()));
}
