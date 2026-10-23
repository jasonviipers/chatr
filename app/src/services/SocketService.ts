import { socketUrl } from '../config';
import { RealtimeSocket } from './RealtimeSocket';
import type { PublishCallbacks } from './RealtimeSocket';

export default class SocketService {
  protected static client: RealtimeSocket;

  static connect(): void {
    // the socket itself is opened on first use
    SocketService.client = new RealtimeSocket({ url: socketUrl });
  }

  static subscribe(channel: string, callback: (payload: any) => void): void {
    SocketService.client.subscribe(channel, (payload) => callback(payload));
  }

  static unsubscribe(channel: string): void {
    SocketService.client.unsubscribe(channel);
  }

  static publish(channel: string, payload: any, callbacks?: PublishCallbacks): void {
    SocketService.client.publish(channel, payload, callbacks);
  }

  /** Tells the server which WebRTC peer id this tab owns (the host's peer id is the meeting id). */
  static identify(peerId: string, token: string): void {
    SocketService.client.identify(peerId, token);
  }
}
