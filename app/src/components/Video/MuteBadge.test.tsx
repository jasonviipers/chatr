import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MuteBadge from './MuteBadge';

describe('MuteBadge', () => {
  it('shows nothing while the microphone is on', () => {
    const { container } = render(<MuteBadge muted={false} who="Participant" />);
    expect(container.firstChild).toBeNull();
  });

  it('says who muted themselves', () => {
    render(<MuteBadge muted who="Participant" />);
    expect(screen.getByLabelText('Participant muted the microphone')).toBeTruthy();
  });
});
