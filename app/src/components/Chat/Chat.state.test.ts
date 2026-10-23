import { describe, expect, it } from 'vitest';
import { MAX_MESSAGES, actions, initialState, reducers } from './Chat.state';
import type { ChatMessage, ChatState } from './Chat.state';

const message = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  from: 'peer-b',
  text: `text ${id}`,
  at: 1000,
  mine: false,
  status: 'sent',
  ...overrides,
});
const run = (state: ChatState, ...list: ReturnType<(typeof actions)[keyof typeof actions]>[]) =>
  list.reduce((current, action) => reducers(current, action), state);

describe('chat state', () => {
  it('appends messages in arrival order and counts the unread ones while the panel is closed', () => {
    const state = run(initialState, actions.pushChatMessage(message('a')), actions.pushChatMessage(message('b')));
    expect(state.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(state.unread).toBe(2);
  });

  it('does not count messages as unread while the panel is open, or our own', () => {
    const open = run(initialState, actions.replaceChatOpen(true), actions.pushChatMessage(message('a')));
    expect(open.unread).toBe(0);
    const mine = run(initialState, actions.pushChatMessage(message('m', { mine: true, status: 'sending' })));
    expect(mine.unread).toBe(0);
  });

  it('opening the panel clears the unread count, closing it keeps counting from zero', () => {
    let state = run(initialState, actions.pushChatMessage(message('a')), actions.replaceChatOpen(true));
    expect(state.unread).toBe(0);
    state = run(state, actions.replaceChatOpen(false), actions.pushChatMessage(message('b')));
    expect(state.unread).toBe(1);
  });

  it('a duplicate delivery is not shown twice and not counted twice', () => {
    const state = run(initialState, actions.pushChatMessage(message('a')), actions.pushChatMessage(message('a')));
    expect(state.messages).toHaveLength(1);
    expect(state.unread).toBe(1);
  });

  it('our own message goes from sending to sent when the server echoes it, and moves to the order everybody sees', () => {
    let state = run(
      initialState,
      actions.pushChatMessage(message('mine1', { mine: true, from: 'me', status: 'sending', at: 1 })),
      actions.pushChatMessage(message('theirs')), // arrived meanwhile
    );
    expect(state.messages.map((m) => m.id)).toEqual(['mine1', 'theirs']);

    state = run(state, actions.pushChatMessage(message('mine1', { mine: true, from: 'me', status: 'sent', at: 2000 })));
    expect(state.messages.map((m) => m.id)).toEqual(['theirs', 'mine1']);
    expect(state.messages[1]).toMatchObject({ status: 'sent', at: 2000, text: 'text mine1' });
    expect(state.unread).toBe(1); // only the other person's message
  });

  it('marks a message failed, and a late "sending" never downgrades one that was already sent', () => {
    let state = run(initialState, actions.pushChatMessage(message('m', { mine: true, status: 'sending' })), actions.replaceChatStatus('m', 'failed'));
    expect(state.messages[0]?.status).toBe('failed');
    state = run(state, actions.replaceChatStatus('m', 'sending')); // retry
    expect(state.messages[0]?.status).toBe('sending');
    state = run(state, actions.replaceChatStatus('m', 'sent'), actions.replaceChatStatus('m', 'sending'));
    expect(state.messages[0]?.status).toBe('sent');
  });

  it('keeps only the latest messages', () => {
    let state = initialState;
    for (let i = 0; i < MAX_MESSAGES + 25; i++) state = run(state, actions.pushChatMessage(message(`m${i}`)));
    expect(state.messages).toHaveLength(MAX_MESSAGES);
    expect(state.messages[0]?.id).toBe('m25');
  });

  it('resets when the meeting ends', () => {
    const state = run(initialState, actions.pushChatMessage(message('a')), actions.replaceChatOpen(true), actions.resetChat());
    expect(state).toEqual(initialState);
  });
});
