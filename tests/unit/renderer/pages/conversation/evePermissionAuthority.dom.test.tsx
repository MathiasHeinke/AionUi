/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import AgentModeSelector from '@/renderer/components/agent/AgentModeSelector';
import { COMMAND_EVE_HG4_DELEGATED_MODE } from '@/renderer/utils/model/agentModes';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configGetMock, configSetMock, emitMock, getModeInvokeMock, messageWarningMock, setModeInvokeMock } = vi.hoisted(
  () => ({
    configGetMock: vi.fn(),
    configSetMock: vi.fn(),
    emitMock: vi.fn(),
    getModeInvokeMock: vi.fn(),
    messageWarningMock: vi.fn(),
    setModeInvokeMock: vi.fn(),
  })
);

vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      getMode: { invoke: getModeInvokeMock },
      setMode: { invoke: setModeInvokeMock },
    },
  },
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    set: configSetMock,
  },
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('@/renderer/utils/emitter', () => ({
  emitter: { emit: emitMock },
}));

vi.mock('@/renderer/components/agent/MarqueePillLabel', () => ({
  default: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: { ...actual.Message, warning: messageWarningMock } };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

describe('AgentModeSelector EVE permission authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configSetMock.mockResolvedValue(undefined);
    configGetMock.mockImplementation((key: string) => {
      if (key === 'acp.config') {
        return {
          claude: { preferredMode: 'bypassPermissions' },
          hermes: { preferredMode: 'dont_ask' },
        };
      }
      return undefined;
    });
  });

  it('pushes dont_ask into an existing EVE chat and publishes only the acknowledged mode', async () => {
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });
    setModeInvokeMock.mockResolvedValue({ mode: 'dont_ask', initialized: true });

    render(<AgentModeSelector backend='hermes' conversation_id='eve-chat' initialMode='default' compact />);

    await waitFor(() => {
      expect(setModeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'eve-chat', mode: 'dont_ask' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'dont_ask');
    });
    expect(emitMock).toHaveBeenLastCalledWith('acp.permission.mode', {
      conversation_id: 'eve-chat',
      mode: 'dont_ask',
    });
  });

  it('keeps auto-approval gated when the backend does not acknowledge dont_ask', async () => {
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });
    setModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });

    render(<AgentModeSelector backend='hermes' conversation_id='eve-chat' initialMode='default' compact />);

    await waitFor(() => {
      expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'default');
    });
    expect(emitMock).not.toHaveBeenCalledWith('acp.permission.mode', {
      conversation_id: 'eve-chat',
      mode: 'dont_ask',
    });
    expect(emitMock).toHaveBeenCalledWith('acp.permission.mode', {
      conversation_id: 'eve-chat',
      mode: 'default',
    });
  });

  it('does not apply another agent global preference to an existing chat', async () => {
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });

    render(<AgentModeSelector backend='claude' conversation_id='claude-chat' initialMode='default' compact />);

    await waitFor(() => {
      expect(getModeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'claude-chat' });
    });
    expect(setModeInvokeMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'default');
  });

  it('bounds the EVE menu and shows the scoped HG4 risk before selection', async () => {
    configGetMock.mockImplementation((key: string) =>
      key === 'acp.config' ? { hermes: { preferredMode: 'default' } } : undefined
    );
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });

    render(
      <AgentModeSelector
        backend='hermes'
        conversation_id='eve-chat'
        initialMode='default'
        dynamicModes={[
          { value: 'default', label: 'Default' },
          { value: 'accept_edits', label: 'Accept edits' },
          { value: 'dont_ask', label: 'Auto' },
          { value: 'untrusted_runtime_mode', label: 'Untrusted' },
        ]}
        compact
      />
    );

    fireEvent.click(screen.getByTestId('agent-mode-selector-hermes'));
    expect(await screen.findByTestId(`aionrs-mode-option-${COMMAND_EVE_HG4_DELEGATED_MODE}`)).toHaveTextContent(
      'Warned sensitive actions through HG3.5'
    );
    expect(screen.queryByTestId('aionrs-mode-option-untrusted_runtime_mode')).not.toBeInTheDocument();
  });

  it('does not display a stale HG4 delegation without a durable conversation grant', async () => {
    configGetMock.mockImplementation((key: string) =>
      key === 'acp.config' ? { hermes: { preferredMode: 'dont_ask' } } : undefined
    );
    getModeInvokeMock.mockResolvedValue({ mode: 'dont_ask', initialized: true });

    render(
      <AgentModeSelector
        backend='hermes'
        conversation_id='eve-chat'
        initialMode={COMMAND_EVE_HG4_DELEGATED_MODE}
        compact
      />
    );

    await waitFor(() => expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'dont_ask'));
    expect(emitMock).not.toHaveBeenCalledWith('acp.permission.mode', {
      conversation_id: 'eve-chat',
      mode: COMMAND_EVE_HG4_DELEGATED_MODE,
    });
  });

  it('activates HG4 delegation only after matching backend ack and durable persistence', async () => {
    configGetMock.mockImplementation((key: string) =>
      key === 'acp.config' ? { hermes: { preferredMode: 'default' } } : undefined
    );
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });
    let acknowledgeMode!: (value: { mode: string; initialized: boolean }) => void;
    setModeInvokeMock.mockReturnValue(
      new Promise((resolve) => {
        acknowledgeMode = resolve;
      })
    );

    render(<AgentModeSelector backend='hermes' conversation_id='eve-chat' initialMode='default' compact />);
    await waitFor(() => expect(getModeInvokeMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('agent-mode-selector-hermes'));
    fireEvent.click(await screen.findByTestId(`aionrs-mode-option-${COMMAND_EVE_HG4_DELEGATED_MODE}`));

    await waitFor(() =>
      expect(setModeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'eve-chat', mode: 'dont_ask' })
    );
    expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'default');
    expect(configSetMock).not.toHaveBeenCalled();

    acknowledgeMode({ mode: 'dont_ask', initialized: true });

    await waitFor(() =>
      expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', COMMAND_EVE_HG4_DELEGATED_MODE)
    );
    expect(configSetMock).toHaveBeenCalledWith(
      'acp.config',
      expect.objectContaining({
        hermes: expect.objectContaining({
          preferredMode: 'dont_ask',
          hg4Delegations: expect.objectContaining({
            'eve-chat': expect.objectContaining({
              active: true,
              scope: 'conversation',
              authority: 'through_hg3_5',
              backendMode: 'dont_ask',
            }),
          }),
        }),
      })
    );
    expect(emitMock).toHaveBeenLastCalledWith('acp.permission.mode', {
      conversation_id: 'eve-chat',
      mode: COMMAND_EVE_HG4_DELEGATED_MODE,
    });
  });

  it('revokes HG4 immediately and keeps the restrictive UI when backend setMode fails', async () => {
    configGetMock.mockImplementation((key: string) =>
      key === 'acp.config'
        ? {
            hermes: {
              preferredMode: 'dont_ask',
              hg4Delegations: {
                'eve-chat': {
                  active: true,
                  scope: 'conversation',
                  authority: 'through_hg3_5',
                  conversationId: 'eve-chat',
                  backendMode: 'dont_ask',
                  grantedAt: '2026-07-17T18:00:00.000Z',
                  riskAcknowledgedAt: '2026-07-17T18:00:00.000Z',
                  updatedAt: '2026-07-17T18:00:00.000Z',
                },
              },
            },
          }
        : undefined
    );
    getModeInvokeMock.mockResolvedValue({ mode: 'dont_ask', initialized: true });
    setModeInvokeMock.mockRejectedValue(new Error('backend unavailable'));

    render(<AgentModeSelector backend='hermes' conversation_id='eve-chat' initialMode='dont_ask' compact />);
    await waitFor(() =>
      expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', COMMAND_EVE_HG4_DELEGATED_MODE)
    );

    fireEvent.click(screen.getByTestId('agent-mode-selector-hermes'));
    fireEvent.click(await screen.findByTestId('aionrs-mode-option-default'));

    await waitFor(() =>
      expect(setModeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'eve-chat', mode: 'default' })
    );
    expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'default');
    await waitFor(() => expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-mode-sync-state', 'warning'));
    expect(emitMock).toHaveBeenCalledWith('acp.permission.mode', {
      conversation_id: 'eve-chat',
      mode: 'default',
    });
    expect(configSetMock).toHaveBeenCalledWith(
      'acp.config',
      expect.objectContaining({
        hermes: expect.objectContaining({
          preferredMode: 'default',
          hg4Delegations: expect.objectContaining({
            'eve-chat': expect.objectContaining({ active: false, revokedAt: expect.any(String) }),
          }),
          hg4DelegationAudit: expect.arrayContaining([
            expect.objectContaining({ event: 'revoked', conversationId: 'eve-chat' }),
          ]),
        }),
      })
    );
    expect(emitMock.mock.invocationCallOrder.at(-1)).toBeLessThan(setModeInvokeMock.mock.invocationCallOrder.at(-1)!);
  });
});
