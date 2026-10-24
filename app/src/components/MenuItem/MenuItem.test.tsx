import { fireEvent, render, screen } from '@testing-library/react';
import { micOffOutline, micOutline, videocamOffOutline, videocamOutline, handRightOutline, lockClosedOutline, lockOpenOutline } from 'ionicons/icons';
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
    expect(screen.getByLabelText('Turn camera on')).toBeTruthy();
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

describe('the lock button', () => {
  it('shows an open lock while the meeting is open, a closed one once the host has locked it', () => {
    expect(iconOf(show({ name: 'lock', active: false }).container)).toBe(lockOpenOutline);
    expect(iconOf(show({ name: 'lock', active: true }).container)).toBe(lockClosedOutline);
  });

  it('says what a click does: lock when open, unlock when locked', () => {
    show({ name: 'lock', active: false });
    expect(screen.getByLabelText('Lock meeting')).toBeTruthy();
    show({ name: 'lock', active: true });
    expect(screen.getByLabelText('Unlock meeting')).toBeTruthy();
  });

  it('can be clicked either way, and is not drawn for those who may not use it', () => {
    const handleClick = vi.fn();
    show({ name: 'lock', active: true, handleClick });
    fireEvent.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledTimes(1);
    expect(show({ name: 'lock', visibility: false }).container.firstChild).toBeNull();
  });
});

describe('the noise reduction button', () => {
  it('says what a click does: turn the cleaning off while it is on, on while it is off', () => {
    show({ name: 'noise', active: true });
    expect(screen.getByLabelText('Turn noise reduction off')).toBeTruthy();
    show({ name: 'noise', active: false });
    expect(screen.getByLabelText('Turn noise reduction on')).toBeTruthy();
  });

  it('is highlighted while the cleaning is on and shown at full strength while it is off, with the same icon', () => {
    const on = show({ name: 'noise', active: true }).container;
    const off = show({ name: 'noise', active: false }).container;
    expect(iconOf(on)).toBe(iconOf(off));
    expect(on.querySelector('ion-icon')?.className).toMatch(/active/);
    expect(off.querySelector('ion-icon')?.className).toMatch(/off/);
  });

  it('is not drawn where the browser cannot do it', () => {
    expect(show({ name: 'noise', visibility: false }).container.firstChild).toBeNull();
  });
});
