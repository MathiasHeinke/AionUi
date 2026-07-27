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
