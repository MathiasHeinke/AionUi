/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import AgentModeSelector from '@/renderer/components/agent/AgentModeSelector';
import { render, screen, waitFor } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configGetMock, configSetMock, emitMock, getModeInvokeMock, setModeInvokeMock } = vi.hoisted(() => ({
  configGetMock: vi.fn(),
  configSetMock: vi.fn(),
  emitMock: vi.fn(),
  getModeInvokeMock: vi.fn(),
  setModeInvokeMock: vi.fn(),
}));

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
});
