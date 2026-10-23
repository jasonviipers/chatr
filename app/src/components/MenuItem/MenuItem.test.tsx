import { fireEvent, render, screen } from '@testing-library/react';
import { micOffOutline, micOutline, videocamOffOutline, videocamOutline, handRightOutline } from 'ionicons/icons';
import { describe, expect, it, vi } from 'vitest';
import MenuItem from './MenuItem';
import type { MenuItemProps } from './MenuItem';

const show = (props: Partial<MenuItemProps> & Pick<MenuItemProps, 'name'>) =>
  render(<MenuItem active visibility handleClick={vi.fn()} {...props} />);
/** the icon the button shows (ionicons are inlined as data URLs, so compare by the `icon` property) */
const iconOf = (container: HTMLElement) => (container.querySelector('ion-icon') as (HTMLElement & { icon: string }) | null)?.icon;

describe('microphone and camera buttons', () => {
  it('the microphone button shows a slashed microphone when it is muted, a plain one when it is on', () => {
    expect(iconOf(show({ name: 'audio', active: true }).container)).toBe(micOutline);
    expect(iconOf(show({ name: 'audio', active: false }).container)).toBe(micOffOutline);
  });

  it('the camera button shows a slashed camera when no picture is being sent', () => {
    expect(iconOf(show({ name: 'video', active: true }).container)).toBe(videocamOutline);
    expect(iconOf(show({ name: 'video', active: false }).container)).toBe(videocamOffOutline);
  });

  it('says in words what the button does now, for screen readers and as a tooltip', () => {
    show({ name: 'audio', active: true });
    expect(screen.getByLabelText('Mute microphone').getAttribute('title')).toBe('Mute microphone');
    show({ name: 'audio', active: false });
    expect(screen.getByLabelText('Unmute microphone')).toBeTruthy();
    show({ name: 'video', active: false });
    expect(screen.getByLabelText('Camera off')).toBeTruthy();
  });

  it('shows an off switch at full strength, not faded like an unavailable action', () => {
    const off = show({ name: 'audio', active: false }).container.querySelector('ion-icon');
    expect(off?.className).toMatch(/off/);
    expect(off?.className).not.toMatch(/active/);
    const on = show({ name: 'audio', active: true }).container.querySelector('ion-icon');
    expect(on?.className).toMatch(/active/);
  });

  it('is still a button that can be clicked while off', () => {
    const handleClick = vi.fn();
    show({ name: 'audio', active: false, handleClick });
    fireEvent.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});

describe('the other buttons', () => {
  it('keep their own icon whatever active is, and are labelled', () => {
    expect(iconOf(show({ name: 'raiseHand', active: true }).container)).toBe(handRightOutline);
    expect(iconOf(show({ name: 'raiseHand', active: false }).container)).toBe(handRightOutline);
    expect(screen.getAllByLabelText('Raise hand').length).toBeGreaterThan(0);
  });

  it('draws nothing when it is not visible', () => {
    const { container } = show({ name: 'chat', visibility: false });
    expect(container.firstChild).toBeNull();
  });

  it('shows the unread count on the chat button, capped at 9+', () => {
    show({ name: 'chat', badge: 3 });
    expect(screen.getByText('3')).toBeTruthy();
    show({ name: 'chat', badge: 25 });
    expect(screen.getByText('9+')).toBeTruthy();
  });
});
