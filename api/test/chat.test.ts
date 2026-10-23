import { describe, expect, it } from 'vitest';
import {
  CHAT_MAX_LENGTH,
  buildChatPayload,
  cleanChatText,
} from '../src/realtime/chat.ts';

describe('cleanChatText', () => {
  it('keeps ordinary text, including emoji and other scripts', () => {
    expect(cleanChatText('Hello 👋 café 你好')).toBe('Hello 👋 café 你好');
  });

  it('trims, and refuses messages with nothing in them', () => {
    expect(cleanChatText('  hi  ')).toBe('hi');
    expect(cleanChatText('   \n\t ')).toBeNull();
    expect(cleanChatText('')).toBeNull();
  });

  it('refuses what is not text', () => {
    for (const value of [undefined, null, 5, {}, ['a'], true])
      expect(cleanChatText(value)).toBeNull();
  });

  it('keeps line breaks but limits blank lines, and normalises Windows line endings', () => {
    expect(cleanChatText('a\r\nb')).toBe('a\nb');
    expect(cleanChatText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('removes control characters and the bidirectional overrides used to spoof text', () => {
    expect(cleanChatText('a\u0000b\u0007c\u001bd')).toBe('abcd');
    expect(cleanChatText('safe‮txt.exe')).toBe('safetxt.exe');
  });

  it('accepts the longest message and refuses one character more', () => {
    expect(cleanChatText('x'.repeat(CHAT_MAX_LENGTH))).not.toBeNull();
    expect(cleanChatText('x'.repeat(CHAT_MAX_LENGTH + 1))).toBeNull();
  });
});

describe('buildChatPayload', () => {
  it('takes the text from the client and the sender and the time from the server', () => {
    const payload = buildChatPayload(
      'peerAAA123',
      { id: 'msg_abc123', text: ' hello ', from: 'forged', at: 1 },
      1234,
    );
    expect(payload).toEqual({
      id: 'msg_abc123',
      text: 'hello',
      from: 'peerAAA123',
      at: 1234,
    });
  });

  it('refuses unidentified senders', () => {
    expect(buildChatPayload(null, { id: 'msg_abc123', text: 'hi' })).toBeNull();
  });

  it('refuses a malformed id, a missing body, and a bad text', () => {
    expect(buildChatPayload('p', { id: 'x', text: 'hi' })).toBeNull();
    expect(buildChatPayload('p', { id: 'has spaces!', text: 'hi' })).toBeNull();
    expect(buildChatPayload('p', { id: 'msg_abc123' })).toBeNull();
    expect(buildChatPayload('p', null)).toBeNull();
    expect(buildChatPayload('p', 'hi')).toBeNull();
    expect(buildChatPayload('p', { id: 'msg_abc123', text: 7 })).toBeNull();
  });
});
