import { beforeEach, describe, expect, it, vi } from 'vitest';
import store from '../store';
import { actions as meetingActions } from '../pages/Meeting/Meeting.state';
import type { VideoState } from '../pages/Meeting/Meeting.state';

vi.mock('./SocketService', () => ({ default: { publish: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn() } }));

const { default: SocketService } = await import('./SocketService');
const { default: MediaStateService } = await import('./MediaStateService');
const { default: VideoService } = await import('./VideoService');
const { default: RTPSenderService } = await import('./RTPSenderService');

const stream = (tracks: { kind: string; readyState?: string }[] = []) =>
  ({
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video').map((t) => ({ readyState: 'live', ...t })),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio').map((t) => ({ readyState: 'live', ...t })),
  }) as unknown as MediaStream;

const tile = (id: string, overrides: Partial<VideoState> = {}): VideoState => ({
  id,
  stream: stream(),
  kind: 'media',
  raiseHand: false,
  memberRemove: false,
  active: false,
  muted: false,
  streamMuted: { video: true, audio: false },
  renderId: 'r',
  ...overrides,
});
const videoOf = (id: string) => store.getState().meeting.videos.find((v: VideoState) => v.id === id) as VideoState | undefined;

beforeEach(() => {
  store.dispatch(meetingActions.reset());
  store.dispatch(meetingActions.replaceConnectionId('me'));
  store.dispatch(meetingActions.replaceId('host'));
  new MediaStateService().clear();
  vi.mocked(SocketService.publish).mockClear();
});

describe('announcing the camera and the microphone', () => {
  it('shows another participant\'s camera and microphone as they announced them', () => {
    store.dispatch(meetingActions.pushVideo(tile('peer-1')));
    new MediaStateService().receive({ from: 'peer-1', video: true, audio: false });
    expect(videoOf('peer-1')?.streamMuted).toEqual({ video: false, audio: true });

    new MediaStateService().receive({ from: 'peer-1', video: false, audio: true });
    expect(videoOf('peer-1')?.streamMuted).toEqual({ video: true, audio: false });
  });

  it('ignores announcements about ourselves (we know better)', () => {
    store.dispatch(meetingActions.pushVideo(tile('me', { muted: true })));
    new MediaStateService().receive({ from: 'me', video: true, audio: false });
    expect(videoOf('me')?.streamMuted).toEqual({ video: true, audio: false });
  });

  it('a tile that appears after the announcement starts from it (the call connects after the message)', () => {
    new MediaStateService().receive({ from: 'late-peer', video: true, audio: false });
    expect(videoOf('late-peer')).toBeUndefined();
    new VideoService().createMediaVideo('late-peer', stream(), (video) => store.dispatch(meetingActions.pushVideo(video)));
    expect(videoOf('late-peer')?.streamMuted).toEqual({ video: false, audio: true });
  });

  it('a tile nobody has announced anything about starts with the camera off and the microphone on', () => {
    new VideoService().createMediaVideo('stranger', stream(), (video) => store.dispatch(meetingActions.pushVideo(video)));
    expect(videoOf('stranger')?.streamMuted).toEqual({ video: true, audio: false });
  });

  it('publishes our own state: the camera is on only when there is a picture, the microphone unless muted', () => {
    store.dispatch(meetingActions.replaceId('host'));
    store.dispatch(meetingActions.pushVideo(tile('me', { muted: true, stream: stream([{ kind: 'audio' }]) })));
    new MediaStateService().publishOwn();
    expect(SocketService.publish).toHaveBeenLastCalledWith('/mediaState/host', { video: false, audio: true });

    store.dispatch(meetingActions.pullVideo('me'));
    store.dispatch(
      meetingActions.pushVideo(tile('me', { muted: true, stream: stream([{ kind: 'audio' }, { kind: 'video' }]), streamMuted: { video: false, audio: true } })),
    );
    new MediaStateService().publishOwn();
    expect(SocketService.publish).toHaveBeenLastCalledWith('/mediaState/host', { video: true, audio: false });
  });

  it('a shared screen counts as a picture', () => {
    store.dispatch(meetingActions.pushVideo(tile('me', { muted: true, kind: 'screen', stream: stream([{ kind: 'video' }]) })));
    new MediaStateService().publishOwn();
    expect(SocketService.publish).toHaveBeenLastCalledWith('/mediaState/host', { video: true, audio: true });
  });
});

describe('putting pictures on the calls', () => {
  function callWith(videoTrack: unknown) {
    const audioSender = { track: { kind: 'audio', id: 'mic' }, replaceTrack: vi.fn(async () => undefined) };
    const videoSender = { track: videoTrack as unknown, replaceTrack: vi.fn(async (next: unknown) => void (videoSender.track = next)) };
    const peerConnection = {
      getSenders: () => [audioSender, videoSender],
      getTransceivers: () => [
        { receiver: { track: { kind: 'audio' } }, sender: audioSender },
        { receiver: { track: { kind: 'video' } }, sender: videoSender },
      ],
    };
    store.dispatch(meetingActions.pushCall({ connectionId: `c${Math.random()}`, peer: 'peer', peerConnection } as never));
    return { audioSender, videoSender };
  }

  it('the camera goes on every call, and comes off again', () => {
    store.dispatch(meetingActions.replaceId('host'));
    const a = callWith(null);
    const b = callWith(null);
    const camera = { kind: 'video', id: 'cam' } as MediaStreamTrack;
    new RTPSenderService().setVideoTrack(camera);
    expect(a.videoSender.replaceTrack).toHaveBeenCalledWith(camera);
    expect(b.videoSender.replaceTrack).toHaveBeenCalledWith(camera);
    new RTPSenderService().setVideoTrack(null);
    expect(a.videoSender.track).toBeNull();
    expect(b.videoSender.track).toBeNull();
  });

  it('sharing the screen puts it on the video line, and going back to voice only empties the line', () => {
    store.dispatch(meetingActions.replaceId('host'));
    const call = callWith(null);
    const share = stream([{ kind: 'audio' }, { kind: 'video' }]);
    new RTPSenderService().replaceStream(share);
    expect(call.videoSender.replaceTrack).toHaveBeenLastCalledWith(share.getVideoTracks()[0]);
    expect(call.audioSender.replaceTrack).toHaveBeenCalled();

    new RTPSenderService().replaceStream(stream([{ kind: 'audio' }]));
    expect(call.videoSender.replaceTrack).toHaveBeenLastCalledWith(null); // the old picture must not stay on the line
  });

  it('ignores a call that has no connection any more', () => {
    store.dispatch(meetingActions.pushCall({ connectionId: 'dead', peer: 'p' } as never));
    expect(() => new RTPSenderService().setVideoTrack(null)).not.toThrow();
  });
});
