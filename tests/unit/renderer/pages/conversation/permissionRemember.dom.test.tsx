/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageAcpPermission } from '@/common/chat/chatLib';
import MessageAcpPermission from '@/renderer/pages/conversation/Messages/acp/MessageAcpPermission';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { confirmMessageMock, configSetMock } = vi.hoisted(() => ({
  confirmMessageMock: vi.fn(),
  configSetMock: vi.fn(),
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  conversation: { confirmMessage: { invoke: confirmMessageMock } },
}));

vi.mock('@/common/config/configService', () => ({
  configService: { get: configGetMock, set: configSetMock },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

function makeCard(command: string): IMessageAcpPermission {
  return {
    id: 'permission-message',
    msg_id: 'permission-message',
    type: 'acp_permission',
    position: 'left',
    conversation_id: 'conversation-1',
    content: {
      session_id: 'session-1',
      options: [
        { option_id: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { option_id: 'reject_once', name: 'Deny', kind: 'reject_once' },
      ],
      tool_call: {
        tool_call_id: 'call-1',
        kind: 'execute',
        title: 'Run it',
        raw_input: { command },
      },
    },
  } as IMessageAcpPermission;
}

const pick = (optionId: string) => {
  fireEvent.click(screen.getByTestId(`message-acp-permission-option-${optionId}`).querySelector('input')!);
};

beforeEach(() => {
  confirmMessageMock.mockReset().mockResolvedValue({ success: true });
  configSetMock.mockReset().mockResolvedValue(undefined);
});

describe('Command EVE ACP cards rely on native permission options only', () => {
  it('does not render an extra remembered-command control', () => {
    render(<MessageAcpPermission message={makeCard('git status')} isCommandEve />);
    pick('allow_once');
    expect(screen.queryByTestId('message-acp-permission-remember')).toBeNull();
  });

  it('answers through ACP without writing Command EVE authority config', async () => {
    render(<MessageAcpPermission message={makeCard('git status')} isCommandEve />);
    pick('allow_once');
    fireEvent.click(screen.getByTestId('message-acp-permission-confirm'));

    await waitFor(() => expect(confirmMessageMock).toHaveBeenCalled());
    expect(configSetMock).not.toHaveBeenCalled();
  });
});
