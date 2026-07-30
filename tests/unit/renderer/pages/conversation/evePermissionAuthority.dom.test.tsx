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

vi.mock('@/renderer/utils/emitter', () => ({ emitter: { emit: emitMock } }));

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

describe('AgentModeSelector Command EVE C0 containment', () => {
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

  it('publishes a wider EVE mode only after the backend acknowledges it', async () => {
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });
    setModeInvokeMock.mockResolvedValue({ mode: 'dont_ask', initialized: true });

    render(<AgentModeSelector backend='hermes' conversation_id='eve-chat' initialMode='default' compact />);

    await waitFor(() =>
      expect(setModeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'eve-chat', mode: 'dont_ask' })
    );
    await waitFor(() => expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'dont_ask'));
    expect(emitMock).toHaveBeenLastCalledWith('acp.permission.mode', {
      conversation_id: 'eve-chat',
      mode: 'dont_ask',
    });
  });

  it('keeps the restrictive mode when a wider EVE mode is not acknowledged', async () => {
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });
    setModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });

    render(<AgentModeSelector backend='hermes' conversation_id='eve-chat' initialMode='default' compact />);

    await waitFor(() => expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'default'));
    expect(emitMock).not.toHaveBeenCalledWith('acp.permission.mode', {
      conversation_id: 'eve-chat',
      mode: 'dont_ask',
    });
  });

  // PINS PRE-EXISTING BEHAVIOUR, not the mapper fix: an independent review argued
  // that a silent backend would leave a stale WIDE session_mode on the pill while
  // this seat's stored grant was the narrow one. It does not, because
  // resolveConversationMode (agentSelectionUtils.ts:137) seeds EVE conversations
  // from the stored grant ahead of session_mode. This test exists to keep that
  // precedence from being reversed later — it passes with or without the fix.
  it('seeds from the stored restriction, not from a stale wide session_mode', async () => {
    configGetMock.mockImplementation((key: string) => {
      if (key === 'acp.config') return { hermes: { preferredMode: 'default' } };
      return undefined;
    });
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: false });

    render(<AgentModeSelector backend='hermes' conversation_id='eve-chat' initialMode='dont_ask' compact />);

    await waitFor(() => expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'default'));
    expect(setModeInvokeMock).not.toHaveBeenCalled();
  });

  // The pill SEEDS from this seat's stored grant, so a wide grant is displayed
  // before any backend confirmation — by design, it is the operator's own choice.
  // What must not happen is that an unverifiable wide mode reads as settled.
  it('marks a wide stored grant as unconfirmed when the backend reports nothing', async () => {
    configGetMock.mockImplementation((key: string) => {
      if (key === 'acp.config') return { hermes: { preferredMode: 'dont_ask' } };
      return undefined;
    });
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: false });

    render(<AgentModeSelector backend='hermes' conversation_id='eve-chat' initialMode='default' compact />);

    await waitFor(() =>
      expect(screen.getByTestId('agent-mode-selector-hermes')).toHaveAttribute('data-mode-sync-state', 'warning')
    );
    expect(setModeInvokeMock).not.toHaveBeenCalled();
  });

  // Regression: the passive-sync path dropped the pill to the narrower mode with no
  // signal whatsoever when a widening was not confirmed — a downgrade to "Ask" that
  // looked like a settled state. The in-session pick path always warned; this one did not.
  it('marks the pill when a requested widening is not confirmed', async () => {
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });
    setModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });

    render(<AgentModeSelector backend='hermes' conversation_id='eve-chat' initialMode='default' compact />);

    await waitFor(() =>
      expect(screen.getByTestId('agent-mode-selector-hermes')).toHaveAttribute('data-mode-sync-state', 'warning')
    );
  });

  it('marks the pill when the widening round-trip fails outright', async () => {
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });
    setModeInvokeMock.mockRejectedValue(new Error('backend unreachable'));

    render(<AgentModeSelector backend='hermes' conversation_id='eve-chat' initialMode='default' compact />);

    await waitFor(() =>
      expect(screen.getByTestId('agent-mode-selector-hermes')).toHaveAttribute('data-mode-sync-state', 'warning')
    );
  });

  // Regression: on a NON-EVE backend the in-session pick adopted whatever setMode
  // echoed back. With no mode option in the payload that is the fabricated
  // `default` placeholder, so the pill snapped to "Default" over the choice the
  // user had just made — the same defect the EVE branch guards against.
  it('keeps a non-EVE pick when setMode answers un-established', async () => {
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });
    setModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: false });

    render(<AgentModeSelector backend='claude' conversation_id='claude-chat' initialMode='default' compact />);

    await waitFor(() => expect(getModeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'claude-chat' }));
    fireEvent.click(screen.getByTestId('agent-mode-selector-claude'));
    fireEvent.click(await screen.findByTestId('aionrs-mode-option-bypassPermissions'));

    await waitFor(() =>
      expect(setModeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'claude-chat', mode: 'bypassPermissions' })
    );
    expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'bypassPermissions');
  });

  it('does not apply another ACP backend preference to a conversation', async () => {
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });

    render(<AgentModeSelector backend='claude' conversation_id='claude-chat' initialMode='default' compact />);

    await waitFor(() => expect(getModeInvokeMock).toHaveBeenCalledWith({ conversation_id: 'claude-chat' }));
    expect(setModeInvokeMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'default');
  });

  it('shows only the three real Hermes modes and truthful Auto copy', async () => {
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
          { value: COMMAND_EVE_HG4_DELEGATED_MODE, label: 'Legacy Guarded Auto' },
          { value: 'untrusted_runtime_mode', label: 'Untrusted' },
        ]}
        compact
      />
    );

    fireEvent.click(screen.getByTestId('agent-mode-selector-hermes'));
    expect(await screen.findByTestId('aionrs-mode-option-dont_ask')).toHaveTextContent('terminal commands');
    expect(screen.queryByTestId(`aionrs-mode-option-${COMMAND_EVE_HG4_DELEGATED_MODE}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId('aionrs-mode-option-untrusted_runtime_mode')).not.toBeInTheDocument();
  });

  it('ignores a persisted HG4 record and fails a stale renderer mode closed', async () => {
    configGetMock.mockImplementation((key: string) =>
      key === 'acp.config'
        ? {
            hermes: {
              hg4Delegations: {
                'eve-chat': {
                  active: true,
                  authority: 'through_hg3_5',
                  conversationId: 'eve-chat',
                },
              },
            },
          }
        : undefined
    );
    getModeInvokeMock.mockResolvedValue({ mode: 'default', initialized: true });

    render(
      <AgentModeSelector
        backend='hermes'
        conversation_id='eve-chat'
        initialMode={COMMAND_EVE_HG4_DELEGATED_MODE}
        compact
      />
    );

    await waitFor(() => expect(screen.getByTestId('mode-selector')).toHaveAttribute('data-current-mode', 'default'));
    expect(setModeInvokeMock).not.toHaveBeenCalledWith({ conversation_id: 'eve-chat', mode: 'dont_ask' });
    expect(emitMock).not.toHaveBeenCalledWith('acp.permission.mode', {
      conversation_id: 'eve-chat',
      mode: COMMAND_EVE_HG4_DELEGATED_MODE,
    });
  });
});
