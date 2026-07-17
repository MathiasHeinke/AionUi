import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ConversationBusyModeControl from '@/renderer/pages/conversation/platforms/ConversationBusyModeControl';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      ({
        'conversation.commandQueue.busyModeAria': 'Busy send mode',
        'conversation.commandQueue.busyModeQueue': 'Afterwards',
        'conversation.commandQueue.busyModeQueueTooltip': 'Send after the current run finishes.',
        'conversation.commandQueue.busyModeSteer': 'Correction',
        'conversation.commandQueue.busyModeSteerTooltip': 'Push into the current run.',
      })[key] ??
      options?.defaultValue ??
      key,
  }),
}));

describe('ConversationBusyModeControl', () => {
  it('keeps a stable hidden layout slot while idle', () => {
    const { container } = render(<ConversationBusyModeControl visible={false} value='queue' onChange={vi.fn()} />);
    const control = container.querySelector('[data-testid="conversation-busy-mode-control"]');
    expect(control).toHaveClass('is-hidden');
    expect(control).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('input[type="radio"][value="queue"]')).toBeDisabled();
  });

  it('uses compact accessible icons and switches the send mode', () => {
    const onChange = vi.fn();
    render(<ConversationBusyModeControl visible value='queue' onChange={onChange} />);

    expect(screen.queryByText('Afterwards')).not.toBeInTheDocument();
    expect(screen.queryByText('Correction')).not.toBeInTheDocument();
    expect(screen.getByTestId('conversation-busy-mode-queue')).toHaveAttribute(
      'title',
      'Afterwards: Send after the current run finishes.'
    );
    expect(screen.getByTestId('conversation-busy-mode-steer')).toHaveAttribute(
      'title',
      'Correction: Push into the current run.'
    );

    fireEvent.click(screen.getByRole('radio', { name: 'Correction' }));
    expect(onChange).toHaveBeenCalledWith('steer');
  });
});
