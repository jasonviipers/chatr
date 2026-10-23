import { IonIcon } from '@ionic/react';
import { personCircleOutline } from 'ionicons/icons';
import React, { Component } from 'react';
import { VideoState } from '../../pages/Meeting/Meeting.state';
import MeetingService from '../../services/MeetingService';
import styles from './AudioOnly.module.scss';

interface AudioOnlyProps {
  video: VideoState;
}

/**
 * Whether the tile has a picture to show: a live video track, and the camera announced as on (or a shared screen,
 * which is always worth showing). A line without a picture on it still has a track, so the track alone proves nothing.
 */
export function hasPicture(video: Pick<VideoState, 'stream' | 'streamMuted' | 'kind'>): boolean {
  if (video.kind !== 'screen' && video.streamMuted.video) return false;
  return video.stream.getVideoTracks().some((track) => track.readyState === 'live');
}

/** Who a tile belongs to, in words: Chatr meetings are anonymous, so this is all there is to tell people apart. */
export function tileLabel(video: Pick<VideoState, 'id' | 'muted'>, isHost: (id: string) => boolean): string {
  if (video.muted) return 'You'; // the local tile is the one played muted
  return isHost(video.id) ? 'Host' : 'Participant';
}

/**
 * Chatr meetings are voice meetings: most people have no picture, and an empty <video> is a black square.
 * This covers such a tile with an avatar and a label instead. The <video> underneath keeps playing (it is
 * what carries the audio), and the cover goes away by itself when a picture (a shared screen) arrives.
 */
export default class AudioOnly extends Component<AudioOnlyProps> {
  private readonly meetingService = new MeetingService();
  private stream: MediaStream | null = null;

  constructor(props: AudioOnlyProps) {
    super(props);
    this.refresh = this.refresh.bind(this);
  }

  componentDidMount() {
    this.listen();
  }

  componentDidUpdate() {
    this.listen();
  }

  componentWillUnmount() {
    this.stream?.removeEventListener('addtrack', this.refresh);
    this.stream?.removeEventListener('removetrack', this.refresh);
  }

  /** a track can be added to or removed from the same stream when a screen share starts or stops */
  private listen() {
    const { stream } = this.props.video;
    if (stream === this.stream) return;
    this.stream?.removeEventListener('addtrack', this.refresh);
    this.stream?.removeEventListener('removetrack', this.refresh);
    this.stream = stream;
    stream.addEventListener('addtrack', this.refresh);
    stream.addEventListener('removetrack', this.refresh);
  }

  private refresh() {
    this.forceUpdate();
  }

  render() {
    const { video } = this.props;
    if (hasPicture(video)) return null;
    const label = tileLabel(video, (id) => this.meetingService.isHostMeeting(id));
    return (
      <div className={styles.audioOnly} role="img" aria-label={`${label}, audio only`}>
        <IonIcon className={styles.icon} icon={personCircleOutline} />
        <span className={styles.label}>{label}</span>
      </div>
    );
  }
}
