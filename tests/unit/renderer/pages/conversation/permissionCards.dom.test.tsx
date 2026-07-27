/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageAcpPermission, IMessagePermission } from '@/common/chat/chatLib';
import MessageAcpPermission from '@/renderer/pages/conversation/Messages/acp/MessageAcpPermission';
import {
  isPermissionCardInactive,
  isPermissionClassificationUnverified,
  normalizePermissionOptions,
} from '@/renderer/pages/conversation/Messages/acp/permissionCardPolicy';
import MessagePermission from '@/renderer/pages/conversation/Messages/components/MessagePermission';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { confirmationConfirmMock, confirmMessageMock } = vi.hoisted(() => ({
  confirmationConfirmMock: vi.fn(),
  confirmMessageMock: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      confirmation: { confirm: { invoke: confirmationConfirmMock } },
    },
  },
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  conversation: { confirmMessage: { invoke: confirmMessageMock } },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => {
      const translations: Record<string, string> = {
        'messages.permissionExactSession': 'Allow this exact operation in this session',
        'messages.permissionUnverifiedTitle': 'Unverified operation',
        'messages.permissionUnverifiedDescription': 'Review the exact operation before allowing it.',
        'messages.permissionResponseFailed': 'The permission response could not be applied.',
        'messages.permissionStatus.expired': 'This permission request has expired.',
        'messages.permissionRequest': 'Permission Request',
        'messages.agentRequestingPermission': 'The agent is requesting permission.',
        'messages.command': 'Command:',
        'messages.chooseAction': 'Choose an action:',
        'messages.option': 'Option',
        'messages.noOptionsAvailable': 'No options available',
        'messages.processing': 'Processing...',
        'messages.confirm': 'Confirm',
        'messages.responseSentSuccessfully': 'Response sent successfully',
      };
      return translations[key] ?? options?.defaultValue ?? key;
    },
  }),
}));

function makeAcpPermission(status?: string): IMessageAcpPermission {
  return {
    id: 'permission-message',
    msg_id: 'permission-message',
    type: 'acp_permission',
    position: 'left',
    conversation_id: 'conversation-1',
    content: {
      session_id: 'session-1',
      status,
      options: [
        { option_id: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { option_id: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
        { option_id: 'allow_always', name: 'Allow always', kind: 'allow_always' },
        { option_id: 'reject_once', name: 'Deny', kind: 'reject_once' },
        { option_id: 'reject_always', name: 'Deny always', kind: 'reject_always' },
      ],
      tool_call: {
        tool_call_id: 'call-1',
        kind: 'execute',
        title: 'Run python formatter',
        raw_input: { command: 'python3 formatter.py' },
      },
    },
  } as IMessageAcpPermission;
}

function makeConfirmation(status?: string, action = 'exec'): IMessagePermission {
  return {
    id: 'confirmation-message',
    msg_id: 'confirmation-message',
    type: 'permission',
    position: 'left',
    conversation_id: 'conversation-1',
    content: {
      id: 'confirmation-1',
      title: 'Run python formatter',
      description: 'Execute the formatter in this workspace',
      action,
      call_id: 'call-1',
      status,
      options: [
        { value: 'allow_once', label: 'Allow once' },
        { value: 'allow_session', label: 'Allow for session' },
        { value: 'allow_always', label: 'Allow always' },
        { value: 'deny_always', label: 'Deny always' },
      ],
    },
  } as IMessagePermission;
}

function addAuthority(
  message: IMessagePermission,
  overrides: Partial<Record<string, unknown>> = {}
): IMessagePermission {
  return {
    ...message,
    content: {
      ...message.content,
      authority: {
        protocol_version: 1,
        operation_id: message.content.call_id,
        operation_digest: 'operation-digest',
        confirmation_version: 7,
        policy_revision: 4,
        session_epoch: 2,
        created_at_ms: 100,
        expires_at_ms: 10_000,
        lifecycle: 'pending',
        classification: 'hg4',
        required_authority: 'founder',
        runtime_receipt_digest: 'runtime-receipt',
        ...overrides,
      },
    },
  } as IMessagePermission;
}

describe('Command EVE permission card policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmationConfirmMock.mockResolvedValue(undefined);
    confirmMessageMock.mockResolvedValue(undefined);
  });

  it('filters durable options but preserves the exact-session UI intent only for EVE', () => {
    const options = [
      { id: 'allow_once', kind: 'allow_once', label: 'Allow once' },
      { id: 'allow_session', kind: 'allow_always', label: 'Allow for session' },
      { id: 'allow_always', kind: 'allow_always', label: 'Allow always' },
      { id: 'reject_always', kind: 'reject_always', label: 'Deny always' },
    ];

    const eve = normalizePermissionOptions(options, true);
    expect(eve.map((option) => option.id)).toEqual(['allow_once', 'allow_session']);
    expect(eve.find((option) => option.id === 'allow_session')?.exactSessionIntent).toBe(true);
    expect(normalizePermissionOptions(options, false)).toHaveLength(4);
  });

  it('recognizes unknown classification and terminal lifecycle states', () => {
    expect(isPermissionClassificationUnverified(undefined)).toBe(true);
    expect(isPermissionClassificationUnverified('unknown')).toBe(true);
    expect(isPermissionClassificationUnverified('hg2')).toBe(false);
    expect(isPermissionCardInactive('expired')).toBe(true);
    expect(isPermissionCardInactive('pending')).toBe(false);
  });

  it('renders an honest EVE ACP card and removes durable Always options', () => {
    render(<MessageAcpPermission message={makeAcpPermission()} isCommandEve />);

    expect(screen.getByTestId('message-acp-permission-unverified')).toBeTruthy();
    expect(screen.getByTestId('message-acp-permission-option-allow_once')).toBeTruthy();
    expect(screen.getByTestId('message-acp-permission-option-allow_session')).toHaveTextContent(
      'Allow this exact operation in this session'
    );
    expect(screen.queryByTestId('message-acp-permission-option-allow_always')).not.toBeInTheDocument();
    expect(screen.queryByTestId('message-acp-permission-option-reject_always')).not.toBeInTheDocument();
  });

  it('does not change the option set for another ACP backend', () => {
    render(<MessageAcpPermission message={makeAcpPermission()} />);

    expect(screen.getByTestId('message-acp-permission-option-allow_always')).toBeTruthy();
    expect(screen.getByTestId('message-acp-permission-option-reject_always')).toBeTruthy();
    expect(screen.queryByTestId('message-acp-permission-unverified')).not.toBeInTheDocument();
  });

  it('keeps an expired EVE card visible but disables its controls', () => {
    render(<MessageAcpPermission message={makeAcpPermission('expired')} isCommandEve />);

    expect(screen.getByTestId('message-acp-permission-card')).toHaveAttribute('data-permission-inactive', 'true');
    expect(screen.getByTestId('message-acp-permission-inactive-banner')).toBeTruthy();
    expect(screen.getByTestId('message-acp-permission-confirm')).toBeDisabled();
  });

  it('honors the AionCore confirmation.update expiry shape', () => {
    const expired = makeConfirmation(undefined, 'expired');
    expired.content.options = [];
    render(<MessagePermission message={expired} isCommandEve />);

    expect(screen.getByTestId('message-permission-card')).toHaveAttribute('data-permission-inactive', 'true');
    expect(screen.getByTestId('message-permission-inactive-banner')).toBeTruthy();
    expect(screen.getByTestId('message-permission-confirm')).toBeDisabled();
  });

  it('uses the server authority lifecycle and exposes revision metadata for E2E', () => {
    render(<MessagePermission message={addAuthority(makeConfirmation(), { lifecycle: 'expired' })} isCommandEve />);

    const card = screen.getByTestId('message-permission-card');
    expect(card).toHaveAttribute('data-permission-inactive', 'true');
    expect(card).toHaveAttribute('data-permission-status', 'expired');
    expect(card).toHaveAttribute('data-permission-classification', 'hg4');
    expect(card).toHaveAttribute('data-permission-required-authority', 'founder');
    expect(card).toHaveAttribute('data-permission-confirmation-version', '7');
    expect(card).toHaveAttribute('data-permission-policy-revision', '4');
    expect(card).toHaveAttribute('data-permission-session-epoch', '2');
    expect(screen.getByTestId('message-permission-confirm')).toBeDisabled();
  });

  it('shows a confirmation error without reporting false success', async () => {
    confirmationConfirmMock.mockRejectedValue(new Error('expired'));
    render(<MessagePermission message={makeConfirmation()} isCommandEve />);

    const radio = screen.getByTestId('message-permission-option-allow_once').querySelector('input');
    expect(radio).toBeTruthy();
    fireEvent.click(radio!);
    fireEvent.click(screen.getByTestId('message-permission-confirm'));

    await waitFor(() => expect(screen.getByTestId('message-permission-error')).toBeTruthy());
    expect(screen.queryByText(/Response sent successfully/)).not.toBeInTheDocument();
  });

  it('treats an explicit HTTP-200 authority rejection as failure', async () => {
    confirmMessageMock.mockResolvedValue({ success: false });
    render(<MessageAcpPermission message={makeAcpPermission()} isCommandEve />);

    const radio = screen.getByTestId('message-acp-permission-option-allow_once').querySelector('input');
    expect(radio).toBeTruthy();
    fireEvent.click(radio!);
    fireEvent.click(screen.getByTestId('message-acp-permission-confirm'));

    await waitFor(() => expect(screen.getByTestId('message-acp-permission-error')).toBeTruthy());
    expect(screen.queryByText(/Response sent successfully/)).not.toBeInTheDocument();
  });
});
