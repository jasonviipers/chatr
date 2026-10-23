import React, { Component } from 'react';
import { VideoState } from '../../pages/Meeting/Meeting.state';
import styles from './Video.module.scss';

interface VideoProps {
  video: VideoState
}

interface VideoLocalState {
  renderId: string
}

/**
 * The picture of a participant, and (for everybody but yourself) their voice.
 *
 * The voice is played by an <audio> element of its own. A <video> element does not start playing until it has
 * a first picture, and while nobody has a camera on, the video line of a call carries none: its audio would
 * stay silent. The <video> is therefore always muted and only shows the picture.
 */
export default class Video extends Component<VideoProps, VideoLocalState> {
	/** the audio of the stream this tile was given (made once per stream) */
	private voice: MediaStream | null = null;
	private voiceOf: MediaStream | null = null;

	constructor (props: VideoProps) {
		super(props);
		this.state = {
			renderId: this.props.video.renderId
		};
		this.setSource = this.setSource.bind(this);
		this.setVoice = this.setVoice.bind(this);
	}

	get className () {
		const isScreen = (this.props.video.kind === 'screen');
		// only your own camera is mirrored, like a mirror; other people are shown as they are
		const filpClass = !isScreen && this.props.video.muted && styles.horizontalFlip;
		return `${styles.video} ${filpClass}`;
	}

	setSource (element: HTMLVideoElement | null) {
		const { video } = this.props;
		if (element && video) {
			element.srcObject = video.stream;
		}
	}

	setVoice (element: HTMLAudioElement | null) {
		const { stream } = this.props.video;
		if (!element) return;
		if (this.voiceOf !== stream) {
			this.voiceOf = stream;
			this.voice = new MediaStream(stream.getAudioTracks());
		}
		if (element.srcObject !== this.voice) element.srcObject = this.voice;
	}

	shouldComponentUpdate (props: VideoProps, state: VideoState) {
		const { renderId } = props.video;
		const hasChangedRenderId = (renderId !== state.renderId);
		if (hasChangedRenderId) this.setState({ renderId });
		return hasChangedRenderId;
	}

	render () {
		return (
			<>
				<video
					className={this.className}
					autoPlay={true}
					muted={true}
					playsInline={true}
					ref={element => this.setSource(element)} // Fix blank video
				/>
				{!this.props.video.muted && (
					<audio
						autoPlay={true}
						ref={element => this.setVoice(element)}
					/>
				)}
			</>
		);
	}
}
