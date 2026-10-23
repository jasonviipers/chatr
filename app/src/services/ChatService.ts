import { nanoid } from 'nanoid';
import store from '../store';
import {
  actions as chatActions,
  selectors as chatSelectors,
} from '../components/Chat/Chat.state';
import type { ChatPayload } from '../components/Chat/Chat.state';
import socket from '../pages/Meeting/Meeting.socket';
import MeetingService from './MeetingService';

/** The same limit the server enforces (api/src/realtime/chat.ts). */
export const CHAT_MAX_LENGTH = 1000;

/**
 * Meeting chat. A message appears on screen at once as "sending"; the realtime socket delivers it even over
 * a bad connection (it waits in an outbox and is re-sent after a reconnect), and it turns into "sent" when
 * the server takes it. Only a refusal (too fast, too long) makes it "failed", and the user can retry.
 */
export default class ChatService {
  private readonly meetingService = new MeetingService();

  get isOpen(): boolean {
    return chatSelectors(store.getState()).open;
  }

  toggle(): void {
    store.dispatch(chatActions.replaceChatOpen(!this.isOpen));
  }

  open(): void {
    store.dispatch(chatActions.replaceChatOpen(true));
  }

  close(): void {
    store.dispatch(chatActions.replaceChatOpen(false));
  }

  /** Sends what the user typed; false when there is nothing to send. */
  send(text: string): boolean {
    const clean = text.trim();
    if (clean.length === 0 || clean.length > CHAT_MAX_LENGTH) return false;
    const message = {
      id: nanoid(16),
      text: clean,
      from: this.meetingService.getConnectionId(),
      at: Date.now(),
      mine: true,
      status: 'sending' as const,
    };
    store.dispatch(chatActions.pushChatMessage(message));
    this.publish(message.id, message.text);
    return true;
  }

  /** Tries again a message that was refused. */
  retry(id: string): void {
    const message = chatSelectors(store.getState()).messages.find((m) => m.id === id);
    if (!message || !message.mine || message.status !== 'failed') return;
    store.dispatch(chatActions.replaceChatStatus(id, 'sending'));
    this.publish(id, message.text);
  }

  /** A message from the server: somebody else's, or our own coming back. */
  receive(payload: ChatPayload): void {
    const mine = payload.from === this.meetingService.getConnectionId();
    store.dispatch(chatActions.pushChatMessage({ ...payload, mine, status: 'sent' }));
  }

  reset(): void {
    store.dispatch(chatActions.resetChat());
  }

  private publish(id: string, text: string): void {
    const meetingId = this.meetingService.getMeetingId();
    socket.chat.publish(
      meetingId,
      { id, text },
      {
        onAck: () => store.dispatch(chatActions.replaceChatStatus(id, 'sent')),
        onRejected: () => store.dispatch(chatActions.replaceChatStatus(id, 'failed')),
      },
    );
  }
}
