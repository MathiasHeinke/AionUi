import type { IMessageAcpPermission } from '@/common/chat/chatLib';
import MessageAcpPermission from '@/renderer/pages/conversation/Messages/acp/MessageAcpPermission';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';

describe('MessageAcpPermission', () => {
  it('renders a visible fallback card when a recovered ACP request lacks tool metadata', () => {
    const message = {
      id: 'permission-message',
      msg_id: 'permission-message',
      type: 'acp_permission',
      position: 'left',
      conversation_id: 'conversation-1',
      content: {
        session_id: 'session-1',
        options: [{ option_id: 'allow_once', name: 'Allow once', kind: 'allow_once' }],
      },
    } as IMessageAcpPermission;

    render(<MessageAcpPermission message={message} />);

    expect(screen.getByTestId('message-acp-permission-card')).toBeTruthy();
    expect(screen.getByTestId('message-acp-permission-option-allow_once')).toBeTruthy();
  });
});
