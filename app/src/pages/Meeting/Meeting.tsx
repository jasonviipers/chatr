import { IonCol, IonContent, IonGrid, IonPage, IonRow, isPlatform } from '@ionic/react';
import React, { Component } from 'react';
import { connect } from 'react-redux';
import { RouteComponentProps, withRouter } from '../../components/withRouter/withRouter';
import { every, filter, find, forEach, includes } from 'lodash';
import { MediaConnection } from 'peerjs';
import { DrawingAddEvent } from '../../services/Whiteboard/WhiteboardDrawingService';
import routes from '../../routes';
import { appBaseUrl } from '../../config';
import PeerService from '../../services/PeerService';
import MediaService from '../../services/MediaService';
import MeetingService from '../../services/MeetingService';
import VideoService from '../../services/VideoService';
import AuthService from '../../services/AuthService';
import AlertService from '../../services/AlertService';
import NotificationService from '../../services/NotificationService';
import WhiteboardDrawingService from '../../services/Whiteboard/WhiteboardDrawingService';
import WhiteboardCanvasService from '../../services/Whiteboard/WhiteboardCanvasService';
import ScreenCaptureService from '../../services/ScreenCaptureService';
import RTPSenderService from '../../services/RTPSenderService';
import StreamTrackService from '../../services/StreamTrackService';
import AppStorage from '../../components/App/App.storage';
import HostMiddleware from '../../middleware/HostMiddleware';
import MeetingRepository from '../../repositories/MeetingRepository';
import socket from './Meeting.socket';
import { selectors, actions, MeetingState, MeetingActions, VideoState, MeetingWhiteboardDrawingState } from './Meeting.state';
import { selectors as chatSelectors } from '../../components/Chat/Chat.state';
import Chat from '../../components/Chat/Chat';
import ChatService from '../../services/ChatService';
import MediaStateService from '../../services/MediaStateService';
import { camera } from '../../services/CameraService';
import { callStream, pictureOf, settleCall } from '../../services/OutgoingMedia';
import { hasPicture } from '../../components/Video/AudioOnly';
import Page from '../../components/Page/Page';
import Menu, { MenuPosition } from '../../components/Menu/Menu';
import ActiveVideo from '../../components/ActiveVideo/ActiveVideo';
import VideoBlock from '../../components/VideoBlock/VideoBlock';
import ActiveVideoSkeleton from '../../components/ActiveVideoSkeleton/ActiveVideoSkeleton';
import styles from './Meeting.module.scss';

interface MeetingProps extends MeetingState, MeetingActions, RouteComponentProps {
	chatUnread: number;
}

class Meeting extends Component<MeetingProps> {
	static raiseHandTimeout = 5000;
	static videoColumnSize: string = isPlatform('mobile') ? '4' : '2';
	peerService: PeerService;
	mediaService: MediaService;
	meetingService: MeetingService;
	videoService: VideoService;
	authService: AuthService;
	notificationService: NotificationService;
	chatService: ChatService;
	mediaStateService: MediaStateService;
	whiteboardDrawingService: WhiteboardDrawingService;
	whiteboardCanvasService: WhiteboardCanvasService;
	screenCaptureService: ScreenCaptureService;
	rtpSenderService: RTPSenderService;
	streamTrackService: StreamTrackService;
	appStorage: AppStorage;
	hostMiddleware: HostMiddleware;
	meetingRepository: MeetingRepository;

	constructor (props: MeetingProps) {
		super(props);
		this.peerService = new PeerService();
		this.mediaService = new MediaService();
		this.meetingService = new MeetingService();
		this.videoService = new VideoService();
		this.authService = new AuthService();
		this.notificationService = new NotificationService();
		this.chatService = new ChatService();
		this.mediaStateService = new MediaStateService();
		camera.onEnded(() => this.turnCameraOff()); // unplugged, or the permission was withdrawn
		this.whiteboardDrawingService = new WhiteboardDrawingService();
		this.whiteboardCanvasService = new WhiteboardCanvasService();
		this.screenCaptureService = new ScreenCaptureService();
		this.rtpSenderService = new RTPSenderService();
		this.streamTrackService = new StreamTrackService();
		this.appStorage = new AppStorage();
		this.hostMiddleware = new HostMiddleware();
		this.hostMiddleware.auth(this.props.history);
		this.meetingRepository = new MeetingRepository();
		this.handleMenuRaiseHandClick = this.handleMenuRaiseHandClick.bind(this);
		this.handleMenuChatClick = this.handleMenuChatClick.bind(this);
		this.handleChatSend = this.handleChatSend.bind(this);
		this.handleChatRetry = this.handleChatRetry.bind(this);
		this.handleChatClose = this.handleChatClose.bind(this);
		this.handleMenuEndMeetingClick = this.handleMenuEndMeetingClick.bind(this);
		this.handleMenuVideoClick = this.handleMenuVideoClick.bind(this);
		this.handleMenuAudioClick = this.handleMenuAudioClick.bind(this);
		this.handleMenuScreenShareClick = this.handleMenuScreenShareClick.bind(this);
		this.handleMenuWhiteboardClick = this.handleMenuWhiteboardClick.bind(this);
		this.handleMenuMemberRemoveClick = this.handleMenuMemberRemoveClick.bind(this);
		this.handleMenuToggleChange = this.handleMenuToggleChange.bind(this);
		this.handleVideoBlockClick = this.handleVideoBlockClick.bind(this);
		this.handleWhiteboardCanvasClearClick = this.handleWhiteboardCanvasClearClick.bind(this);
		this.handleWhiteboardDrawingAdd = this.handleWhiteboardDrawingAdd.bind(this);
	}

	isMenuExpanded (position: MenuPosition) {
		const { menuExpanded } = this.props;
		return includes(menuExpanded, position);
	}

	get canMenuTopSpace () {
		return (this.activeVideo && this.isMenuExpanded('top'));
	}

	get className () {
		const mobileClass = isPlatform('mobile') && styles.mobile;
		const menuTopSpaceClass = this.canMenuTopSpace && styles.menuTopSpace;
		return `${styles.meeting} ${mobileClass} ${menuTopSpaceClass}`;
	}

	get activeVideo () {
		return find(this.props.videos, 'active');
	}

	get activeVideoSkeletonVisibility () {
		return !this.activeVideo;
	}

	get activeVideoBlock () {
		return this.activeVideo &&
      <ActiveVideo
      	video={this.activeVideo}
      	whiteboardDrawings={this.props.whiteboardDrawings}
      	whiteboardEnabled={this.props.whiteboardEnabled}
      	handleWhiteboardCanvasClearClick={this.handleWhiteboardCanvasClearClick}
      	handleWhiteboardDrawingAdd={this.handleWhiteboardDrawingAdd}
      	handleVideoBlockClick={this.handleVideoBlockClick} />;
	}

	get videos () {
		const videos = filter(this.props.videos, { active: false });
		return videos.map(video => this.video(video));
	}

	get userVideo () {
		const { connectionId, videos } = this.props;
		return find(videos, { id: connectionId });
	}

	get canInviteMember () {
		return Boolean(this.props.id);
	}

	get canRaiseHand () {
		if (!this.userVideo) return false;
		return !this.userVideo.raiseHand;
	}

	get canEndMeeting () {
		return Boolean(this.props.id);
	}

	/** Whether a picture is being sent: false for a voice-only meeting, so the camera button shows "off" */
	get canVideoMute () {
		if (!this.userVideo) return false;
		return hasPicture(this.userVideo);
	}

	get canAudioMute () {
		if (!this.userVideo) return false;
		return !this.userVideo.streamMuted.audio;
	}

	get canScreenShare () {
		const videos = this.props.videos;
		return every(videos, video => (video.kind !== 'screen'));
	}

	get canWhiteboardEnable () {
		return !this.props.whiteboardEnabled;
	}

	get inviteText () {
		const { id } = this.props;
		return `Hi there,\nYou can join the meeting from ${appBaseUrl}/join?id=${id}`;
	}

	handleStreamStop () {
		const screenStream = this.meetingService.getScreenStream();
		const tracks = screenStream.getTracks();
		forEach(tracks, track => {
			track.onended = () => this.switchUserStreamToMedia();
		});
	}

	switchUserStreamToMedia () {
		this.mediaService.getStream(this.props.history, () => {
			const mediaStream = this.meetingService.getMediaStream();
			const cameraTrack = camera.currentTrack;
			if (cameraTrack) mediaStream.addTrack(cameraTrack); // back from sharing the screen: the camera, if it is on
			this.videoService.replaceUserStream(mediaStream, 'media');
			this.rtpSenderService.replaceStream(mediaStream);
			const screenStream = this.meetingService.getScreenStream();
			this.streamTrackService.stop(screenStream);
		});
	}

	switchUserStreamToScreen () {
		this.screenCaptureService.getStream(() => {
			const screenStream = this.meetingService.getScreenStream();
			this.videoService.replaceUserStream(screenStream, 'screen');
			this.rtpSenderService.replaceStream(screenStream);
			this.handleStreamStop();
			const mediaStream = this.meetingService.getMediaStream();
			// the camera is not part of what is stopped here: it comes back when the sharing ends
			const cameraTrack = camera.currentTrack;
			if (cameraTrack) mediaStream.removeTrack(cameraTrack);
			this.streamTrackService.stop(mediaStream);
		});
	}

	handleMenuRaiseHandClick () {
		if (this.userVideo?.raiseHand) return;
		const { id, connectionId } = this.props;
		socket.raiseHand.publish(id, connectionId);
	}

	handleMenuChatClick () {
		this.chatService.toggle();
	}

	handleChatSend (text: string) {
		return this.chatService.send(text);
	}

	handleChatRetry (id: string) {
		this.chatService.retry(id);
	}

	handleChatClose () {
		this.chatService.close();
	}

	handleMenuEndMeetingClick () {
		const prompt = 'Are you sure to end meeting?';
		AlertService.push(prompt, () => {
			this.peerService.disconnect();
		});
	}

	async handleMenuVideoClick () {
		if (!this.userVideo) return;
		if (this.userVideo.kind === 'screen') {
			AlertService.push('Stop sharing your screen to use the camera');
			return;
		}
		if (camera.isOn) this.turnCameraOff();
		else await this.turnCameraOn();
	}

	async turnCameraOn () {
		try {
			const track = await camera.turnOn();
			const userVideo = this.userVideo;
			if (!userVideo || userVideo.kind === 'screen') return camera.turnOff(); // the screen was shared meanwhile
			userVideo.stream.addTrack(track); // the picture of yourself, and what the calls to come will carry
			this.props.replaceVideoStreamMutedVideo(this.props.connectionId, false);
			this.rtpSenderService.setVideoTrack(track);
			this.mediaStateService.publishOwn();
		} catch {
			AlertService.push('Camera not available');
		}
	}

	turnCameraOff () {
		const track = camera.currentTrack;
		if (track) this.userVideo?.stream.removeTrack(track);
		camera.turnOff();
		this.props.replaceVideoStreamMutedVideo(this.props.connectionId, true);
		if (this.userVideo?.kind !== 'screen') this.rtpSenderService.setVideoTrack(null);
		this.mediaStateService.publishOwn();
	}

	handleMenuAudioClick () {
		if (this.userVideo) {
			const enabled = this.mediaService.toggleAudioMute(this.userVideo.stream);
			this.props.replaceVideoStreamMutedAudio(this.props.connectionId, !enabled);
			this.mediaStateService.publishOwn();
		}
	}

	handleMenuScreenShareClick () {
		if (this.canScreenShare) this.switchUserStreamToScreen();
		else this.switchUserStreamToMedia();
	}

	handleMenuWhiteboardClick () {
		const { id } = this.props;
		const whiteboardEnabled = !this.props.whiteboardEnabled;
		socket.whiteboardEnabled.publish(id, whiteboardEnabled);
		this.props.replaceWhiteboardEnabled(whiteboardEnabled);
	}

	handleMenuMemberRemoveClick () {
		if (this.activeVideo?.memberRemove) {
			const { id } = this.props;
			socket.memberRemove.publish(id, this.activeVideo.id);
		}
	}

	handleMenuToggleChange (position: MenuPosition) {
		const isMenuExpanded = this.isMenuExpanded(position);
		const { pullMenuExpanded, pushMenuExpanded } = this.props;
		const action = isMenuExpanded ? pullMenuExpanded : pushMenuExpanded;
		action(position);
	}

	handleVideoBlockClick (video: VideoState) {
		this.props.replaceVideoActive(video.id, true);
	}

	handleWhiteboardCanvasClearClick () {
		socket.whiteboardCanvasClear.publish(this.props.id);
	}

	handleWhiteboardDrawingAdd (event: DrawingAddEvent) {
		const { id } = this.props;
		const drawing = event.target as MeetingWhiteboardDrawingState;
		this.props.pushWhiteboardDrawing(drawing);
		socket.whiteboardDrawingAdd.publish(id, drawing);
	}

	handleRemoteRaiseHand (meetingId: string) {
		socket.raiseHand.subscribe(meetingId, connectionId => {
			this.props.replaceVideoRaiseHand(connectionId, true);
			setTimeout(() => {
				this.props.replaceVideoRaiseHand(connectionId, false);
			}, Meeting.raiseHandTimeout);
		});
	}

	handleRemoteMediaState (meetingId: string) {
		socket.mediaState.subscribe(meetingId, state => this.mediaStateService.receive(state));
	}

	handleRemoteChat (meetingId: string) {
		socket.chat.subscribe(meetingId, message => this.chatService.receive(message));
	}

	handleRemoteMemberRemove (meetingId: string) {
		socket.memberRemove.subscribe(meetingId, connectionId => {
			const isUser = this.meetingService.isUserMeeting(connectionId);
			if (isUser) this.peerService.disconnect();
			else {
				this.peerService.forget(connectionId);
				this.videoService.pullVideo(connectionId);
				this.meetingRepository.setHostVideoActive();
			}
		});
	}

	handleRemoteDisconnect (meetingId: string) {
		socket.remoteDisconnect.subscribe(meetingId, connectionId => {
			this.peerService.forget(connectionId); // they left on purpose: do not try to call them back
			const isHostMeeting = this.meetingService.isHostMeeting(connectionId);
			if (isHostMeeting) this.exitMeeting();
			else this.videoService.pullVideo(connectionId);
		});
	}

	handleRemoteRTPTrackReplacement (meetingId: string) {
		socket.rtpTrackReplaced.subscribe(meetingId, payload => {
			const { connectionId, kind } = payload;
			this.props.replaceVideoKind(connectionId, kind);
			this.props.updateVideoRenderId(connectionId);
		});
	}

	handleRemoteConferenceCall (meetingId: string, localStream: MediaStream) {
		socket.conferenceCall.subscribe(meetingId, connectionId => {
			this.notificationService.notifyMember(connectionId);
			if (this.meetingService.canConferenceCall(connectionId)) {
				this.peerService.call(connectionId, localStream, call => {
					this.meetingService.pushCall(call);
					this.handleCallStreaming(call);
					this.settleVideo(call);
				}, this.outgoingStream(localStream));
			}
		});
	}

	handleRemoteWhiteboardEnabled (meetingId: string) {
		socket.whiteboardEnabled.subscribe(meetingId, whiteboardEnabled => {
			this.props.replaceWhiteboardEnabled(whiteboardEnabled);
		});
	}

	handleRemoteWhiteboardDrawingAdd (meetingId: string) {
		socket.whiteboardDrawingAdd.subscribe(meetingId, drawing => {
			const isDrawingExists = this.whiteboardDrawingService.isExists(drawing);
			if (!isDrawingExists) {
				this.whiteboardDrawingService.parse(drawing, drawings => {
					this.whiteboardDrawingService.add(drawings);
				});
			}
		});
	}

	handleRemoteWhiteboardDrawingSync (localConnectionId: string) {
		socket.whiteboardDrawingSync.subscribe(localConnectionId, whiteboardSync => {
			const { drawings, whiteboardEnabled } = whiteboardSync;
			if (whiteboardEnabled) {
				this.props.replaceWhiteboardEnabled(whiteboardEnabled);
			}
			this.props.replaceWhiteboardDrawings(drawings);
			socket.whiteboardDrawingSync.unsubscribe(localConnectionId);
		});
	}

	handleRemoteWhiteboardCanvasClear (meetingId: string) {
		socket.whiteboardCanvasClear.subscribe(meetingId, () => {
			this.whiteboardCanvasService.clear();
			this.props.replaceWhiteboardDrawings([]);
		});
	}

	menu (position: MenuPosition) {
		return this.activeVideo &&
      <Menu
      	position={position}
      	canInviteMember={this.canInviteMember}
      	canRaiseHand={this.canRaiseHand}
      	canEndMeeting={this.canEndMeeting}
      	canVideoMute={this.canVideoMute}
      	canAudioMute={this.canAudioMute}
      	canScreenShare={this.canScreenShare}
      	canWhiteboardEnable={this.canWhiteboardEnable}
      	canMemberRemove={this.activeVideo.memberRemove}
      	chatUnread={this.props.chatUnread}
      	inviteText={this.inviteText}
      	isExpanded={this.isMenuExpanded(position)}
      	handleRaiseHandClick={this.handleMenuRaiseHandClick}
      	handleChatClick={this.handleMenuChatClick}
      	handleEndMeetingClick={this.handleMenuEndMeetingClick}
      	handleVideoClick={this.handleMenuVideoClick}
      	handleAudioClick={this.handleMenuAudioClick}
      	handleScreenShareClick={this.handleMenuScreenShareClick}
      	handleWhiteboardClick={this.handleMenuWhiteboardClick}
      	handleMemberRemoveClick={this.handleMenuMemberRemoveClick}
      	handleToggleChange={this.handleMenuToggleChange}
      />;
	}

	video (video: VideoState) {
		return (
			<IonCol
				size={Meeting.videoColumnSize}
				key={video.id}>
				<VideoBlock
					ratio="square"
					video={video}
					handleClick={this.handleVideoBlockClick} />
			</IonCol>
		);
	}

	socketUnsubscribe () {
		const { id } = this.props;
		socket.raiseHand.unsubscribe(id);
		socket.chat.unsubscribe(id);
		socket.mediaState.unsubscribe(id);
		socket.conferenceCall.unsubscribe(id);
		socket.rtpTrackReplaced.unsubscribe(id);
		socket.remoteDisconnect.unsubscribe(id);
		socket.memberRemove.unsubscribe(id);
		socket.whiteboardEnabled.unsubscribe(id);
		socket.whiteboardDrawingAdd.unsubscribe(id);
		socket.whiteboardCanvasClear.unsubscribe(id);
	}

	handleDisconnect () {
		this.peerService.onDisconnect(() => {
			const { id, connectionId } = this.props;
			socket.remoteDisconnect.publish(id, connectionId);
			this.exitMeeting();
		});
	}

	whiteboardDrawingSync (connectionId: string) {
		const { whiteboardEnabled, whiteboardDrawings: drawings } = this.props;
		const whiteboardSync = { drawings, whiteboardEnabled };
		socket.whiteboardDrawingSync.publish(connectionId, whiteboardSync);
	}

	exitMeeting () {
		this.videoService.stopUserVideo();
		this.meetingService.resetMeeting();
		this.socketUnsubscribe();
		this.chatService.reset();
		camera.turnOff();
		this.mediaStateService.clear();
		this.peerService.disconnect();
		this.authService.resetType();
		this.props.replaceWhiteboardEnabled(false);
		this.props.replaceWhiteboardDrawings([]);
		this.appStorage.removeAccessToken(() => {
			this.props.history.push(routes.home.path);
		});
	}

	handleUserStream (localConnectionId: string, localStream: MediaStream) {
		this.videoService.createMediaVideo(localConnectionId, localStream, localVideo => {
			this.videoService.pushVideo(localVideo);
		});
	}

	handleCallStreaming (call: MediaConnection) {
		this.peerService.onCalling(call, (remoteConnectionId, remoteStream) => {
			this.videoService.createMediaVideo(remoteConnectionId, remoteStream, remoteVideo => {
				this.videoService.pushVideo(remoteVideo);
			});
			this.mediaStateService.publishOwn(); // they may have joined after we switched the camera or the microphone
		});
		// Someone whose connection died without a goodbye would otherwise stay on screen as a frozen picture
		this.peerService.onCallEnded(call, () => {
			this.meetingService.pullCall(call);
			// the store keeps deep copies of the calls: compare by id and look at the live peer connection
			const stillTalking = this.meetingService.getCalls().some(other => {
				const state = other.peerConnection?.iceConnectionState;
				return other.connectionId !== call.connectionId && other.peer === call.peer && (state === 'connected' || state === 'completed');
			});
			if (!stillTalking) this.videoService.pullVideo(call.peer);
		});
	}

	handleReceiveCall (meetingId: string, localStream: MediaStream) {
		this.peerService.onReceiveCall(call => {
			this.meetingService.pushCall(call);
			const { peer: connectionId } = call;
			this.peerService.answerCall(call, callStream(this.userVideo?.stream ?? localStream));
			this.settleVideo(call);
			this.whiteboardDrawingSync(connectionId);
			socket.conferenceCall.publish(meetingId, connectionId);
			this.notificationService.notifyHost(connectionId);
			this.handleCallStreaming(call);
		});
	}

	/** What we send to others right now: our voice and, if there is one, our camera or the screen being shared. */
	outgoingStream (fallback: MediaStream) {
		return () => callStream(this.userVideo?.stream ?? fallback);
	}

	/** The picture that should be on the video line of a call now (usually none, then nothing is sent). */
	desiredPicture () {
		return this.userVideo ? pictureOf(this.userVideo.stream) : null;
	}

	/** Once a call is negotiated, take the placeholder off its video line. */
	settleVideo (call: MediaConnection) {
		if (call.peerConnection) settleCall(call.peerConnection, () => this.desiredPicture());
	}

	joinMeeting (meetingId: string, localConnectionId: string, localStream: MediaStream) {
		if (this.meetingService.isMemberMeeting(localConnectionId)) {
			this.peerService.call(meetingId, localStream, call => {
				this.meetingService.pushCall(call);
				this.handleCallStreaming(call);
				this.settleVideo(call);
			}, this.outgoingStream(localStream));
		}
	}

	handleMeeting () {
		const { history } = this.props;
		this.peerService.handleErrors(history);
		// Somebody could not be reached for minutes. Losing the host means the meeting is over for us.
		this.peerService.onRedialGiveUp(peerId => {
			if (!this.meetingService.isHostMeeting(peerId)) return;
			AlertService.push('Lost the connection to the meeting');
			this.exitMeeting();
		});
		this.peerService.onOpen(localConnectionId => {
			this.meetingService.setId(localConnectionId, meetingId => {
				if (meetingId) {
					this.handleRemoteRaiseHand(meetingId);
					this.handleRemoteChat(meetingId);
					this.handleRemoteMediaState(meetingId);
					this.handleRemoteMemberRemove(meetingId);
					this.handleDisconnect();
					this.mediaService.getStream(history, localStream => {
						this.handleUserStream(localConnectionId, localStream);
						this.handleReceiveCall(meetingId, localStream);
						this.joinMeeting(meetingId, localConnectionId, localStream);
						this.handleRemoteDisconnect(meetingId);
						this.handleRemoteRTPTrackReplacement(meetingId);
						this.handleRemoteConferenceCall(meetingId, localStream);
						this.handleRemoteWhiteboardEnabled(meetingId);
						this.handleRemoteWhiteboardDrawingAdd(meetingId);
						this.handleRemoteWhiteboardDrawingSync(localConnectionId);
						this.handleRemoteWhiteboardCanvasClear(meetingId);
					});
				} else this.exitMeeting();
			});
		});
	}

	componentWillUnmount () {
		this.exitMeeting();
	}

	componentDidMount () {
		this.handleMeeting();
	}

	render () {
		return (
			<IonPage>
				<IonContent>
					<Page
						invert={false}
						container="full">
						<div className={this.className}>
							<IonGrid>
								<IonRow>
									{this.activeVideoBlock}
									<ActiveVideoSkeleton visibility={this.activeVideoSkeletonVisibility} />
								</IonRow>
								<IonRow>
									{this.videos}
								</IonRow>
							</IonGrid>
							{this.menu('top')}
							{this.menu('bottom')}
						</div>
						<Chat
							myId={this.props.connectionId}
							hostId={this.props.id}
							onSend={this.handleChatSend}
							onRetry={this.handleChatRetry}
							onClose={this.handleChatClose} />
					</Page>
				</IonContent>
			</IonPage>
		);
	}
}

const mapState = (state: Parameters<typeof selectors>[0] & Parameters<typeof chatSelectors>[0]) => ({
	...selectors(state),
	chatUnread: chatSelectors(state).unread,
});

export default withRouter(connect(mapState, actions)(Meeting));
