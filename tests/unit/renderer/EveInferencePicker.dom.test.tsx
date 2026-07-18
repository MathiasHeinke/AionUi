/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const localItems = [
    { value: 'command-eve-local:local-standard', group: 'local' as const, label: 'Standard', disabled: false },
    { value: 'command-eve-local:local-high', group: 'local' as const, label: 'Hoch', disabled: false },
  ];
  const cloudItems = [
    { value: 'command-eve-inference:eve-standard', group: 'eve' as const, label: 'Standard', disabled: false },
    { value: 'command-eve-inference:eve-high', group: 'eve' as const, label: 'Hoch', disabled: false },
    { value: 'command-eve-inference:eve-xhigh', group: 'eve' as const, label: 'Sehr hoch', disabled: false },
    { value: 'command-eve-inference:eve-max', group: 'eve' as const, label: 'Maximum', disabled: false },
    { value: 'command-eve-inference:eve-ultra', group: 'eve' as const, label: 'Ultra', disabled: false },
  ];
  const commit = vi.fn();
  return {
    localItems,
    cloudItems,
    commit,
    localStatusInvoke: vi.fn(),
    hookState: {
      selection: localItems[0].value,
      groups: [
        { kind: 'local' as const, title: 'Privat (lokal)', items: localItems },
        { kind: 'eve' as const, title: 'EVE Inference (Cloud)', items: cloudItems },
      ],
      selectedItem: localItems[0] as (typeof localItems)[number] | (typeof cloudItems)[number],
      commit,
      cloudBearerAvailable: true as boolean | undefined,
    },
  };
});

vi.mock('@/renderer/hooks/agent/useEveInferenceSelection', () => ({
  useEveInferenceSelection: () => mocks.hookState,
}));

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: () => ({ invoke: mocks.localStatusInvoke }),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

import EveInferencePicker from '@/renderer/components/agent/EveInferencePicker';

const availableLocalTiers = [
  {
    id: 'gemma-4-e4b-local-default',
    installed: true,
    ram_fit: true,
    ready_for_use: true,
    status_known: true,
  },
  {
    id: 'gemma-4-12b-local-planning',
    installed: true,
    ram_fit: true,
    ready_for_use: true,
    status_known: true,
  },
];

const setOnline = (online: boolean): void => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
};

describe('EveInferencePicker', () => {
  beforeEach(() => {
    mocks.commit.mockReset();
    mocks.localStatusInvoke.mockReset();
    mocks.localStatusInvoke.mockResolvedValue({ success: true, data: { model: { tiers: availableLocalTiers } } });
    mocks.hookState.selection = mocks.localItems[0].value;
    mocks.hookState.selectedItem = mocks.localItems[0];
    mocks.hookState.cloudBearerAvailable = true;
    setOnline(true);
  });

  it('keeps a fixed viewport, internal scroll, and stable selected state while searching', async () => {
    render(<EveInferencePicker />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Ultra')).toBeInTheDocument();
    const shell = document.querySelector('.eve-inference-picker-menu') as HTMLElement | null;
    const scroll = document.querySelector('.eve-inference-picker-scroll') as HTMLElement | null;
    expect(shell?.style.width).toBe('340px');
    expect(shell?.style.height).toBe('462px');
    expect(shell?.style.maxHeight).toBe('calc(100vh - 40px)');
    expect(scroll?.style.overflowY).toBe('auto');

    const selected = screen.getByTestId(`eve-inference-option-${mocks.localItems[0].value}`);
    expect(selected).toHaveAttribute('data-selected', 'true');

    fireEvent.change(screen.getByRole('textbox', { name: 'Modelle durchsuchen' }), { target: { value: 'Ultra' } });
    expect(screen.getByTestId('eve-inference-option-command-eve-inference:eve-ultra')).toBeInTheDocument();
    expect(screen.queryByTestId(`eve-inference-option-${mocks.localItems[0].value}`)).not.toBeInTheDocument();
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('shows no invented CLI agents when search has no routed provider result', async () => {
    render(<EveInferencePicker />);
    fireEvent.click(screen.getByRole('button'));
    await screen.findByText('Ultra');

    fireEvent.change(screen.getByRole('textbox', { name: 'Modelle durchsuchen' }), {
      target: { value: 'Claude Code' },
    });

    expect(screen.getByText('Keine Modelle gefunden')).toBeInTheDocument();
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
  });

  it('keeps a hardware-blocked local selection visible but refuses a new commit', async () => {
    mocks.localStatusInvoke.mockResolvedValue({
      success: true,
      data: {
        model: {
          tiers: [{ ...availableLocalTiers[0], ram_fit: false }, availableLocalTiers[1]],
        },
      },
    });
    render(<EveInferencePicker />);
    await waitFor(() => expect(mocks.localStatusInvoke).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button'));
    const blocked = await screen.findByTestId(`eve-inference-option-${mocks.localItems[0].value}`);
    expect(blocked).toHaveAttribute('data-selected', 'true');
    expect(screen.getByText('Hardware')).toBeInTheDocument();

    fireEvent.click(blocked);
    expect(mocks.commit).not.toHaveBeenCalled();
    expect(screen.getByRole('button')).toHaveTextContent('Nicht verfügbar');
  });

  it('marks cloud tiers as activation-required and does not commit without a bearer', async () => {
    mocks.hookState.selection = mocks.cloudItems[0].value;
    mocks.hookState.selectedItem = mocks.cloudItems[0];
    mocks.hookState.cloudBearerAvailable = false;
    render(<EveInferencePicker />);

    expect(screen.getByRole('button')).toHaveTextContent('Aktivierung nötig');
    fireEvent.click(screen.getByRole('button'));
    const blocked = await screen.findByTestId(`eve-inference-option-${mocks.cloudItems[1].value}`);
    fireEvent.click(blocked);

    expect(mocks.commit).not.toHaveBeenCalled();
    expect(screen.getAllByText('Aktivierung').length).toBeGreaterThan(0);
  });

  it('marks cloud tiers offline and keeps the selection stable', async () => {
    setOnline(false);
    mocks.hookState.selection = mocks.cloudItems[0].value;
    mocks.hookState.selectedItem = mocks.cloudItems[0];
    render(<EveInferencePicker />);

    expect(screen.getByRole('button')).toHaveTextContent('Offline');
    fireEvent.click(screen.getByRole('button'));
    const blocked = await screen.findByTestId(`eve-inference-option-${mocks.cloudItems[1].value}`);
    fireEvent.click(blocked);

    expect(mocks.commit).not.toHaveBeenCalled();
    expect(blocked).toHaveAttribute('data-selected', 'false');
  });
});
