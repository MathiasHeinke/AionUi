import type { IMessageAcpPermission } from '@/common/chat/chatLib';
import MessageAcpPermission from '@/renderer/pages/conversation/Messages/acp/MessageAcpPermission';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

const { confirmMessageMock } = vi.hoisted(() => ({ confirmMessageMock: vi.fn() }));

vi.mock('@/common/adapter/ipcBridge', () => ({
  conversation: { confirmMessage: { invoke: confirmMessageMock } },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      String(options?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (token, name: string) =>
        options?.[name] === undefined ? token : String(options[name])
      ),
  }),
}));

function clarifyMessage(): IMessageAcpPermission {
  return {
    id: 'clarify-message',
    msg_id: 'clarify-message',
    type: 'acp_permission',
    position: 'left',
    conversation_id: 'conversation-1',
    content: {
      session_id: 'conversation-1',
      status: 'pending',
      options: [
        { option_id: 'clarify_choice_0', name: 'Continue', kind: 'allow_once' },
        { option_id: 'clarify_cancel', name: 'Cancel', kind: 'reject_once' },
      ],
      tool_call: {
        tool_call_id: `clarify-${'a'.repeat(32)}`,
        title: 'Which option should I use?',
        kind: 'execute',
        raw_input: {
          question: 'Which option should I use?',
          choices: ['Continue'],
          metadata: {
            interaction_kind: 'clarify',
            question: 'Which option should I use?',
            choices: ['Continue'],
            source_user_turn: 'Create the requested document.',
          },
        },
      },
    },
  } as IMessageAcpPermission;
}

describe('native Hermes clarify rendering', () => {
  it('renders an ordinary clarify card and sends its chosen native confirmation once', async () => {
    confirmMessageMock.mockResolvedValue(undefined);
    render(<MessageAcpPermission message={clarifyMessage()} isCommandEve />);

    expect(screen.getByTestId('message-acp-clarify-card')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abbrechen' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(confirmMessageMock).toHaveBeenCalledWith({
        confirm_key: 'clarify_choice_0',
        msg_id: 'clarify-message',
        conversation_id: 'conversation-1',
        call_id: `clarify-${'a'.repeat(32)}`,
      })
    );
    expect(confirmMessageMock).toHaveBeenCalledTimes(1);
  });

  it('accepts the known AionCore unknown-classification title prefix', () => {
    const message = clarifyMessage();
    message.content.tool_call.title = `[classification=unknown] ${message.content.tool_call.title}`;

    render(<MessageAcpPermission message={message} isCommandEve />);

    expect(screen.getByTestId('message-acp-clarify-card')).toBeInTheDocument();
  });

  it('records the localized cancel label after the native rejection is accepted', async () => {
    confirmMessageMock.mockResolvedValue(undefined);
    render(<MessageAcpPermission message={clarifyMessage()} isCommandEve />);

    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));

    await waitFor(() =>
      expect(confirmMessageMock).toHaveBeenCalledWith({
        confirm_key: 'clarify_cancel',
        msg_id: 'clarify-message',
        conversation_id: 'conversation-1',
        call_id: `clarify-${'a'.repeat(32)}`,
      })
    );
    expect(screen.getByTestId('message-acp-clarify-responded')).toHaveTextContent('Ausgewählt: Abbrechen');
  });
});

describe('native Hermes clarify shape validation', () => {
  it.each([
    ['call id', (message: IMessageAcpPermission) => (message.content.tool_call.tool_call_id = 'call-1')],
    ['kind', (message: IMessageAcpPermission) => (message.content.tool_call.kind = 'edit')],
    ['title', (message: IMessageAcpPermission) => (message.content.tool_call.title = 'Different title')],
    [
      'question',
      (message: IMessageAcpPermission) => (message.content.tool_call.raw_input.question = 'Different question'),
    ],
    [
      'choices',
      (message: IMessageAcpPermission) => (message.content.tool_call.raw_input.choices = ['Different choice']),
    ],
    ['options', (message: IMessageAcpPermission) => (message.content.options[0].kind = 'allow_always')],
    [
      'extra raw-input keys',
      (message: IMessageAcpPermission) =>
        ((message.content.tool_call.raw_input as Record<string, unknown>).extra = true),
    ],
    [
      'extra metadata keys',
      (message: IMessageAcpPermission) =>
        ((message.content.tool_call.raw_input.metadata as Record<string, unknown>).extra = true),
    ],
  ])('falls back to the security permission card for an invalid %s', (_reason, mutate) => {
    const message = clarifyMessage();
    mutate(message);

    render(<MessageAcpPermission message={message} isCommandEve />);

    expect(screen.queryByTestId('message-acp-clarify-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-acp-permission-card')).toBeInTheDocument();
  });
});
