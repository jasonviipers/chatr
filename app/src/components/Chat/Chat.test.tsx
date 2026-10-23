import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Chat } from './Chat';
import type { ChatMessage } from './Chat.state';

const message = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  from: 'guest-abcd',
  text: `message ${id}`,
  at: Date.UTC(2026, 0, 5, 13, 7),
  mine: false,
  status: 'sent',
  ...overrides,
});

function setup(props: Partial<React.ComponentProps<typeof Chat>> = {}) {
  const handlers = { onSend: vi.fn(() => true), onRetry: vi.fn(), onClose: vi.fn() };
  const view = render(<Chat myId="me-1234" hostId="host-99" open messages={[]} {...handlers} {...props} />);
  return { ...handlers, ...view };
}

describe('Chat panel', () => {
  it('invites people to write when there is nothing yet', () => {
    setup();
    expect(screen.getByText(/No messages yet/)).toBeTruthy();
  });

  it('shows who wrote what: you, the host, and guests by the end of their id', () => {
    setup({
      messages: [
        message('1', { from: 'host-99', text: 'welcome' }),
        message('2', { from: 'guest-wxyz', text: 'hello' }),
        message('3', { from: 'me-1234', text: 'hi all', mine: true }),
      ],
    });
    expect(screen.getByText('Host')).toBeTruthy();
    expect(screen.getByText('Participant WXYZ')).toBeTruthy();
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('welcome')).toBeTruthy();
    expect(screen.getByText('hi all')).toBeTruthy();
  });

  it('shows text as plain text, never as markup', () => {
    const { container } = setup({ messages: [message('1', { text: '<img src=x onerror=alert(1)> <b>bold</b>' })] });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)> <b>bold</b>')).toBeTruthy();
  });

  it('says when a message is still on its way, and offers a retry when it was refused', () => {
    const { onRetry } = setup({
      messages: [message('1', { mine: true, status: 'sending' }), message('2', { mine: true, status: 'failed' }), message('3', { mine: true, status: 'sent' })],
    });
    expect(screen.getAllByText('Sending…')).toHaveLength(1);
    fireEvent.click(screen.getByText('Not sent · Retry'));
    expect(onRetry).toHaveBeenCalledWith('2');
  });

  it('sends with Enter, keeps a new line for Shift+Enter, and clears the box once the message was taken', () => {
    const { onSend } = setup();
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: 'hello there' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello there');
    expect(input.value).toBe('');
  });

  it('keeps what was typed when the message was not taken', () => {
    const onSend = vi.fn(() => false);
    setup({ onSend });
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalled();
    expect(input.value).toBe('   ');
  });

  it('the send button is disabled until there is something to send', () => {
    setup();
    const send = screen.getByLabelText('Send message') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'x' } });
    expect(send.disabled).toBe(false);
  });

  it('closes with Escape and with the close button', () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Escape' });
    fireEvent.click(screen.getByLabelText('Close chat'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Escape closes the chat wherever the focus is, but only while it is open', () => {
    const { onClose, rerender } = setup();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<Chat myId="me-1234" hostId="host-99" open={false} messages={[]} onSend={vi.fn(() => true)} onRetry={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1); // closed: Escape belongs to the rest of the page
  });

  it('limits the length and shows a counter when it gets close', () => {
    setup();
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement;
    expect(input.maxLength).toBe(1000);
    fireEvent.change(input, { target: { value: 'x'.repeat(850) } });
    expect(screen.getByText('850/1000')).toBeTruthy();
  });

  it('is hidden from assistive technology and the keyboard while closed', () => {
    const { container } = setup({ open: false });
    expect(container.querySelector('aside')?.getAttribute('aria-hidden')).toBe('true');
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).tabIndex).toBe(-1);
  });
});
