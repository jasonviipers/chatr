import { AnyAction } from 'redux';

export type ChatStatus = 'sending' | 'sent' | 'failed';

/** What the server publishes for every chat message (see api/src/realtime/chat.ts). */
export interface ChatPayload {
  id: string;
  text: string;
  /** peer id of the sender */
  from: string;
  /** server time, ms */
  at: number;
}

export interface ChatMessage extends ChatPayload {
  mine: boolean;
  status: ChatStatus;
}

export interface ChatState {
  open: boolean;
  messages: ChatMessage[];
  /** messages that arrived while the panel was closed */
  unread: number;
}

export interface ChatActions {
  replaceChatOpen: (open: boolean) => AnyAction;
  pushChatMessage: (message: ChatMessage) => AnyAction;
  replaceChatStatus: (id: string, status: ChatStatus) => AnyAction;
  resetChat: () => AnyAction;
}

/** Enough for a long meeting, bounded so a flood cannot grow the page's memory. */
export const MAX_MESSAGES = 300;

export const initialState: ChatState = { open: false, messages: [], unread: 0 };

export const actions: ChatActions = {
  replaceChatOpen: (open) => ({ type: 'REPLACE_CHAT_OPEN', open }),
  pushChatMessage: (message) => ({ type: 'PUSH_CHAT_MESSAGE', message }),
  replaceChatStatus: (id, status) => ({ type: 'REPLACE_CHAT_STATUS', id, status }),
  resetChat: () => ({ type: 'RESET_CHAT' }),
};

export function reducers(state: ChatState = initialState, action: AnyAction): ChatState {
  switch (action.type) {
    case 'REPLACE_CHAT_OPEN':
      return { ...state, open: action.open, unread: action.open ? 0 : state.unread };

    case 'PUSH_CHAT_MESSAGE': {
      const message = action.message as ChatMessage;
      const existing = state.messages.find((m) => m.id === message.id);
      // our own message coming back from the server: it takes its place in the order everybody sees
      const others = state.messages.filter((m) => m.id !== message.id);
      const merged: ChatMessage = existing
        ? { ...existing, at: message.at, status: message.status === 'sent' ? 'sent' : existing.status }
        : message;
      const messages = [...others, merged].slice(-MAX_MESSAGES);
      const isNew = !existing && !message.mine;
      return { ...state, messages, unread: isNew && !state.open ? state.unread + 1 : state.unread };
    }

    case 'REPLACE_CHAT_STATUS':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.id && !(m.status === 'sent' && action.status === 'sending') ? { ...m, status: action.status } : m,
        ),
      };

    case 'RESET_CHAT':
      return initialState;

    default:
      return state;
  }
}

export function selectors(state: { chat: ChatState }): ChatState {
  return state.chat;
}
