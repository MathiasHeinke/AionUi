/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMessageText } from '@/common/chat/chatLib';
import { ConversationProvider } from '@/renderer/hooks/context/ConversationContext';
import MessageText from '@/renderer/pages/conversation/Messages/components/MessageText';

const { readAloudTextMock, isReadAloudAvailableMock, stopReadAloudMock } = vi.hoisted(() => ({
  isReadAloudAvailableMock: vi.fn(() => true),
  readAloudTextMock: vi.fn(() => true),
  stopReadAloudMock: vi.fn(),
}));
const mockFilePreview = vi.fn(({ path }: { path: string }) => <div data-testid='file-preview'>{path}</div>);

vi.mock('@/renderer/components/chat/CollapsibleContent', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/renderer/components/media/FilePreview', () => ({
  __esModule: true,
  default: (props: { path: string }) => mockFilePreview(props),
}));

vi.mock('@/renderer/components/media/HorizontalFileList', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/components/Markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/utils/chat/skillSuggestParser', () => ({
  hasSkillSuggest: () => false,
  stripSkillSuggest: (content: string) => content,
}));

vi.mock('@/renderer/utils/chat/thinkTagFilter', () => ({
  hasThinkTags: () => false,
  stripThinkTags: (content: string) => content,
}));

vi.mock('@/renderer/utils/model/agentLogo', () => ({
  getAgentLogo: () => null,
}));

vi.mock('@/renderer/utils/ui/clipboard', () => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/renderer/services/ReadAloudService', () => ({
  isReadAloudAvailable: isReadAloudAvailableMock,
  readAloudText: readAloudTextMock,
  stopReadAloud: stopReadAloudMock,
}));

vi.mock('@arco-design/web-react', () => ({
  Alert: () => null,
  Button: ({
    'aria-label': ariaLabel,
    icon,
    onClick,
  }: {
    'aria-label'?: string;
    icon?: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type='button' aria-label={ariaLabel} onClick={onClick}>
      {icon}
    </button>
  ),
  Message: {
    error: vi.fn(),
  },
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@icon-park/react', () => ({
  Copy: () => <span data-testid='copy-icon' />,
  PauseOne: () => <span data-testid='pause-icon' />,
  VolumeNotice: () => <span data-testid='volume-icon' />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

describe('MessageText attachment paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isReadAloudAvailableMock.mockReturnValue(true);
    readAloudTextMock.mockReturnValue(true);
  });

  it('resolves relative attachment paths against the current workspace before previewing', () => {
    const message: IMessageText = {
      id: 'msg-1',
      msg_id: 'msg-1',
      conversation_id: 'conv-1',
      type: 'text',
      position: 'right',
      createdAt: Date.now(),
      content: {
        content: 'look at this\n\n[[AION_FILES]]\nuploads/photo.png',
      },
    };

    render(
      <ConversationProvider value={{ conversationId: 'conv-1', workspace: '/workspace/demo', type: 'acp' }}>
        <MessageText message={message} />
      </ConversationProvider>
    );

    expect(screen.getByTestId('file-preview')).toHaveTextContent('/workspace/demo/uploads/photo.png');
  });

  it('keeps absolute attachment paths unchanged before previewing', () => {
    const message: IMessageText = {
      id: 'msg-2',
      msg_id: 'msg-2',
      conversation_id: 'conv-1',
      type: 'text',
      position: 'right',
      createdAt: Date.now(),
      content: {
        content: 'look at this\n\n[[AION_FILES]]\n/Users/demo/Desktop/photo.png',
      },
    };

    render(
      <ConversationProvider value={{ conversationId: 'conv-1', workspace: '/workspace/demo', type: 'acp' }}>
        <MessageText message={message} />
      </ConversationProvider>
    );

    expect(screen.getByTestId('file-preview')).toHaveTextContent('/Users/demo/Desktop/photo.png');
  });

  it('reads assistant messages aloud with the local read-aloud service', () => {
    const message: IMessageText = {
      id: 'msg-3',
      msg_id: 'msg-3',
      conversation_id: 'conv-1',
      type: 'text',
      position: 'left',
      createdAt: Date.now(),
      content: {
        content: 'Assistant answer',
      },
    };

    render(
      <ConversationProvider value={{ conversationId: 'conv-1', workspace: '/workspace/demo', type: 'acp' }}>
        <MessageText message={message} />
      </ConversationProvider>
    );

    screen.getByLabelText('conversation.chat.readAloudTooltip').click();

    expect(readAloudTextMock).toHaveBeenCalledWith('Assistant answer', expect.objectContaining({ lang: 'en-US' }));
  });

  it('does not show read-aloud controls on user messages', () => {
    const message: IMessageText = {
      id: 'msg-4',
      msg_id: 'msg-4',
      conversation_id: 'conv-1',
      type: 'text',
      position: 'right',
      createdAt: Date.now(),
      content: {
        content: 'User prompt',
      },
    };

    render(
      <ConversationProvider value={{ conversationId: 'conv-1', workspace: '/workspace/demo', type: 'acp' }}>
        <MessageText message={message} />
      </ConversationProvider>
    );

    expect(screen.queryByLabelText('conversation.chat.readAloudTooltip')).not.toBeInTheDocument();
  });

  it('toggles stop for active read-aloud playback', async () => {
    const message: IMessageText = {
      id: 'msg-5',
      msg_id: 'msg-5',
      conversation_id: 'conv-1',
      type: 'text',
      position: 'left',
      createdAt: Date.now(),
      content: {
        content: 'Assistant answer',
      },
    };

    render(
      <ConversationProvider value={{ conversationId: 'conv-1', workspace: '/workspace/demo', type: 'acp' }}>
        <MessageText message={message} />
      </ConversationProvider>
    );

    fireEvent.click(screen.getByLabelText('conversation.chat.readAloudTooltip'));
    await waitFor(() => {
      expect(screen.getByLabelText('conversation.chat.stopReadAloudTooltip')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('conversation.chat.stopReadAloudTooltip'));

    expect(stopReadAloudMock).toHaveBeenCalledTimes(1);
  });

  it('stops active read-aloud playback on unmount', async () => {
    const message: IMessageText = {
      id: 'msg-6',
      msg_id: 'msg-6',
      conversation_id: 'conv-1',
      type: 'text',
      position: 'left',
      createdAt: Date.now(),
      content: {
        content: 'Assistant answer',
      },
    };

    const { unmount } = render(
      <ConversationProvider value={{ conversationId: 'conv-1', workspace: '/workspace/demo', type: 'acp' }}>
        <MessageText message={message} />
      </ConversationProvider>
    );

    fireEvent.click(screen.getByLabelText('conversation.chat.readAloudTooltip'));
    await waitFor(() => {
      expect(screen.getByLabelText('conversation.chat.stopReadAloudTooltip')).toBeInTheDocument();
    });
    unmount();

    expect(stopReadAloudMock).toHaveBeenCalledTimes(1);
  });
});
