/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { type PropsWithChildren } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IConversationArtifact } from '@/common/adapter/ipcBridge';
import type { IMessageText, IMessageToolGroup, TMessage } from '@/common/chat/chatLib';
import { MessageListLoadingProvider, MessageListProvider } from '@/renderer/pages/conversation/Messages/hooks';
import MessageList from '@/renderer/pages/conversation/Messages/MessageList';

const artifactMock = vi.hoisted(() => ({
  artifacts: [] as IConversationArtifact[],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; type?: string }) =>
      options?.defaultValue ?? options?.type ?? _key,
  }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({
    key: 'location-key',
    state: {},
  }),
}));

vi.mock('@arco-design/web-react', () => ({
  Message: {
    error: vi.fn(),
  },
  Image: {
    PreviewGroup: ({ children }: PropsWithChildren) => <>{children}</>,
  },
}));

vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => null,
}));

vi.mock('@/renderer/hooks/file/useAutoPreviewOfficeFiles', () => ({
  useAutoPreviewOfficeFiles: () => {},
}));

vi.mock('@/renderer/pages/conversation/Messages/artifacts', () => ({
  useConversationArtifacts: () => artifactMock.artifacts,
}));

vi.mock('@/renderer/pages/conversation/Messages/useAutoScroll', () => ({
  useAutoScroll: () => ({
    handleScrollerRef: () => {},
    handleContentRef: () => {},
    handleScroll: () => {},
    handleWheel: () => {},
    handlePointerDown: () => {},
    showScrollButton: false,
    scrollToBottom: () => {},
    scrollElementIntoView: () => {},
    hideScrollButton: () => {},
  }),
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageText', () => ({
  default: ({ message }: { message: IMessageText }) => <div>{message.content.content}</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageTips', () => ({
  default: () => <div>tips</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolCall', () => ({
  default: () => <div>tool_call</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolGroup', () => ({
  default: () => <div>tool_group</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageAgentStatus', () => ({
  default: () => <div>agent_status</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessagePermission', () => ({
  default: () => <div>permission</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/acp/MessageAcpPermission', () => ({
  default: () => <div>acp_permission</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/acp/MessageAcpToolCall', () => ({
  default: () => <div>acp_tool_call</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessagePlan', () => ({
  default: () => <div>plan</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageThinking', () => ({
  default: () => <div>thinking</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageCronTrigger', () => ({
  default: () => <div>cron_trigger</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageSkillSuggest', () => ({
  default: () => <div>skill_suggest</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary', () => ({
  default: () => <div>tool_summary</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/MessageFileChanges', () => ({
  __esModule: true,
  default: () => <div>file_changes</div>,
  parseDiff: vi.fn(),
}));

vi.mock('@/renderer/pages/conversation/Messages/components/SelectionReplyButton', () => ({
  default: () => null,
}));

vi.mock('@icon-park/react', () => ({
  Down: () => <span>down</span>,
  FolderOpen: () => <span>folder-open</span>,
  Paperclip: () => <span>paperclip</span>,
  PreviewOpen: () => <span>preview-open</span>,
}));

function createTextMessage(): IMessageText {
  return {
    id: 'message-1',
    msg_id: 'msg-1',
    conversation_id: 'conversation-1',
    type: 'text',
    position: 'left',
    content: {
      content: 'streaming reply',
    },
    created_at: 1,
  };
}

function createImageToolGroup(): IMessageToolGroup {
  return {
    id: 'tool-group-1',
    msg_id: 'tool-msg-1',
    conversation_id: 'conversation-1',
    type: 'tool_group',
    position: 'left',
    content: [
      {
        call_id: 'call-1',
        description: 'Generated image',
        name: 'ImageGeneration',
        render_output_as_markdown: false,
        result_display: {
          img_url: 'data:image/png;base64,iVBORw0KGgo=',
          relative_path: 'hero.png',
        },
        status: 'Success',
      },
    ],
    created_at: 1,
  };
}

function Wrapper({
  children,
  messages = [createTextMessage()],
  loading = false,
}: PropsWithChildren<{ messages?: TMessage[]; loading?: boolean }>): JSX.Element {
  return (
    <MessageListLoadingProvider value={loading}>
      <MessageListProvider value={messages}>{children}</MessageListProvider>
    </MessageListLoadingProvider>
  );
}

describe('MessageList', () => {
  afterEach(() => {
    artifactMock.artifacts = [];
  });

  it('renders message rows with external margin spacing in the plain scroll list', () => {
    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper>{children}</Wrapper>,
    });

    expect(screen.getByTestId('message-list-scroller')).toBeInTheDocument();
    expect(screen.getByTestId('message-list-content')).toBeInTheDocument();

    const messageRow = screen.getByTestId('message-text-left');
    expect(messageRow.className).toContain('m-t-10px');
    expect(messageRow.className).not.toContain('pt-10px');
  });

  it('renders the empty slot when there are no messages', () => {
    render(<MessageList emptySlot={<div>empty state</div>} />, {
      wrapper: ({ children }) => <Wrapper messages={[]}>{children}</Wrapper>,
    });

    expect(screen.getByText('empty state')).toBeInTheDocument();
  });

  it('renders a skeleton while the initial message batch is loading', () => {
    render(<MessageList emptySlot={<div>empty state</div>} />, {
      wrapper: ({ children }) => (
        <Wrapper messages={[]} loading>
          {children}
        </Wrapper>
      ),
    });

    expect(screen.getByTestId('message-list-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('empty state')).not.toBeInTheDocument();
  });

  it('renders generated media artifacts from the conversation artifact store', () => {
    artifactMock.artifacts = [
      {
        id: 'artifact-1',
        conversation_id: 'conversation-1',
        kind: 'media',
        status: 'active',
        payload: {
          artifact_type: 'image',
          title: 'Hero render',
          url: 'data:image/png;base64,iVBORw0KGgo=',
          mime_type: 'image/png',
          provider: 'xAI',
          model: 'grok-image',
        },
        created_at: 2,
        updated_at: 2,
      },
    ];

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper>{children}</Wrapper>,
    });

    expect(screen.getByTestId('conversation-artifact-media')).toBeInTheDocument();
    expect(screen.getByTestId('generated-artifact-card')).toBeInTheDocument();
    expect(screen.getByTestId('generated-artifact-image')).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgo=');
    expect(screen.getByText('Hero render')).toBeInTheDocument();
    expect(screen.getByText('xAI · grok-image · image/png')).toBeInTheDocument();
  });

  it('keeps image generation tool results inline instead of collapsing them into the step summary', () => {
    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[createImageToolGroup()]}>{children}</Wrapper>,
    });

    expect(screen.getByText('tool_group')).toBeInTheDocument();
    expect(screen.queryByText('tool_summary')).not.toBeInTheDocument();
  });

  it('does not render the same generated image twice when an artifact card already exists', () => {
    artifactMock.artifacts = [
      {
        id: 'artifact-1',
        conversation_id: 'conversation-1',
        kind: 'media',
        status: 'active',
        payload: {
          artifact_type: 'image',
          title: 'Hero render',
          url: 'data:image/png;base64,iVBORw0KGgo=',
          mime_type: 'image/png',
        },
        created_at: 2,
        updated_at: 2,
      },
    ];

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[createImageToolGroup()]}>{children}</Wrapper>,
    });

    expect(screen.getByTestId('generated-artifact-card')).toBeInTheDocument();
    expect(screen.queryByText('tool_group')).not.toBeInTheDocument();
    expect(screen.getByText('tool_summary')).toBeInTheDocument();
  });
});
