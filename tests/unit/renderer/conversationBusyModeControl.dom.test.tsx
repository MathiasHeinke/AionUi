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
    expect(control).toHaveAttribute('data-state', 'idle');
    expect(control).toHaveAttribute('data-mode', 'queue');
    expect(screen.getByTestId('conversation-busy-mode-trigger')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('conversation-busy-mode-trigger')).toHaveAttribute('tabindex', '-1');
  });

  it('preserves the same control and trigger nodes across idle and busy states', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ConversationBusyModeControl visible={false} value='queue' onChange={onChange} />);
    const control = screen.getByTestId('conversation-busy-mode-control');
    const trigger = screen.getByTestId('conversation-busy-mode-trigger');

    rerender(<ConversationBusyModeControl visible value='steer' onChange={onChange} />);

    expect(screen.getByTestId('conversation-busy-mode-control')).toBe(control);
    expect(screen.getByTestId('conversation-busy-mode-trigger')).toBe(trigger);
    expect(control).toHaveClass('is-visible');
    expect(control).toHaveAttribute('data-state', 'busy');
    expect(control).toHaveAttribute('data-mode', 'steer');
    expect(trigger).toHaveAttribute('aria-disabled', 'false');
    expect(trigger).not.toHaveAttribute('tabindex');
    expect(trigger).toHaveAttribute('aria-label', 'Busy send mode: Correction');
  });

  it('shows one compact mode trigger and switches the send mode from its menu', async () => {
    const onChange = vi.fn();
    render(<ConversationBusyModeControl visible value='queue' onChange={onChange} />);

    expect(screen.queryByText('Afterwards')).not.toBeInTheDocument();
    expect(screen.queryByText('Correction')).not.toBeInTheDocument();
    const trigger = screen.getByTestId('conversation-busy-mode-trigger');
    expect(trigger).toHaveAttribute('aria-label', 'Busy send mode: Afterwards');
    expect(trigger).toHaveAttribute('title', 'Afterwards: Send after the current run finishes.');

    fireEvent.click(trigger);
    expect(await screen.findByTestId('conversation-busy-mode-queue')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('conversation-busy-mode-queue')).toHaveAttribute('role', 'menuitemradio');
    fireEvent.click(await screen.findByTestId('conversation-busy-mode-steer'));
    expect(onChange).toHaveBeenCalledWith('steer');
  });
});
