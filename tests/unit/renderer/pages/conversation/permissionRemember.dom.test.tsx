/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * "Always allow this command" on the EVE permission card.
 *
 * The property that matters most here is a negative one: this control must be
 * unreachable for anything it cannot honestly deliver. A remember offered on a
 * DENY, on a compound command Hermes could never match, or on a card that has
 * not been answered would each be a standing yes the human did not give.
 */

import type { IMessageAcpPermission } from '@/common/chat/chatLib';
import type { EveAuthorityGrant } from '@/common/config/eveAuthorityCore';
import MessageAcpPermission from '@/renderer/pages/conversation/Messages/acp/MessageAcpPermission';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { confirmMessageMock, configGetMock, configSetMock } = vi.hoisted(() => ({
  confirmMessageMock: vi.fn(),
  configGetMock: vi.fn(),
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
  configGetMock
    .mockReset()
    .mockImplementation(async (key: string) =>
      key === 'commandEve.authority'
        ? ({ ladder: 3, capabilities: {}, updatedBy: 'user' } as EveAuthorityGrant)
        : undefined
    );
});

describe('"always allow this command" is offered only when it can be honoured', () => {
  it('is hidden until an allowing answer is selected', () => {
    render(<MessageAcpPermission message={makeCard('git status')} isCommandEve />);
    expect(screen.queryByTestId('message-acp-permission-remember')).toBeNull();
    pick('allow_once');
    expect(screen.getByTestId('message-acp-permission-remember')).toBeTruthy();
  });

  it('disappears again on a refusal', () => {
    render(<MessageAcpPermission message={makeCard('git status')} isCommandEve />);
    pick('allow_once');
    expect(screen.getByTestId('message-acp-permission-remember')).toBeTruthy();
    pick('reject_once');
    // A remember triggered by a DENY would be a standing yes the human never gave.
    expect(screen.queryByTestId('message-acp-permission-remember')).toBeNull();
  });

  it('is never offered for a command Hermes could not match', () => {
    render(<MessageAcpPermission message={makeCard('ls && rm -rf build')} isCommandEve />);
    pick('allow_once');
    // Offering it would promise something silently never kept: the user ticks
    // the box and keeps being asked for the same command.
    expect(screen.queryByTestId('message-acp-permission-remember')).toBeNull();
  });

  it('is not offered outside the Command EVE lane', () => {
    render(<MessageAcpPermission message={makeCard('git status')} />);
    pick('allow_once');
    expect(screen.queryByTestId('message-acp-permission-remember')).toBeNull();
  });
});

describe('what it writes', () => {
  it('stores the literal command only after the answer was accepted', async () => {
    render(<MessageAcpPermission message={makeCard('git status')} isCommandEve />);
    pick('allow_once');
    fireEvent.click(screen.getByTestId('message-acp-permission-remember').querySelector('input')!);
    fireEvent.click(screen.getByTestId('message-acp-permission-confirm'));

    await waitFor(() => expect(configSetMock).toHaveBeenCalled());
    const [key, grant] = configSetMock.mock.calls.at(-1) as [string, EveAuthorityGrant];
    expect(key).toBe('commandEve.authority');
    expect(grant.rememberedCommands).toEqual([
      { command: 'git status', grantedAt: expect.any(String) as unknown as string },
    ]);
  });

  it('writes nothing when the box is left unticked', async () => {
    render(<MessageAcpPermission message={makeCard('git status')} isCommandEve />);
    pick('allow_once');
    fireEvent.click(screen.getByTestId('message-acp-permission-confirm'));
    await waitFor(() => expect(confirmMessageMock).toHaveBeenCalled());
    expect(configSetMock).not.toHaveBeenCalled();
  });

  it('writes nothing when the authority rejected the response', async () => {
    confirmMessageMock.mockResolvedValue({ success: false });
    render(<MessageAcpPermission message={makeCard('git status')} isCommandEve />);
    pick('allow_once');
    fireEvent.click(screen.getByTestId('message-acp-permission-remember').querySelector('input')!);
    fireEvent.click(screen.getByTestId('message-acp-permission-confirm'));

    await waitFor(() => expect(confirmMessageMock).toHaveBeenCalled());
    // Writing the grant first would leave a standing yes behind for a command
    // that was never actually allowed to run.
    expect(configSetMock).not.toHaveBeenCalled();
  });
});
