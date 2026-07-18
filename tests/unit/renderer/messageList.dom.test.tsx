/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { type PropsWithChildren } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IConversationArtifact } from '@/common/adapter/ipcBridge';
import type { IMessageText, IMessageToolGroup, TMessage } from '@/common/chat/chatLib';
import type { MessageHistoryPagination } from '@/renderer/pages/conversation/Messages/hooks';
import { MessageListLoadingProvider, MessageListProvider } from '@/renderer/pages/conversation/Messages/hooks';
import MessageList from '@/renderer/pages/conversation/Messages/MessageList';
import {
  buildGeneratedArtifactFromToolResult,
  getToolResultArtifactSourceKeys,
} from '@/renderer/pages/conversation/Messages/types';

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

vi.mock('@/common', () => ({
  ipcBridge: {
    shell: {
      openFile: { invoke: vi.fn() },
      openExternal: { invoke: vi.fn() },
      showItemInFolder: { invoke: vi.fn() },
    },
    theme: {
      requestCurrent: { invoke: vi.fn().mockResolvedValue(null) },
      changed: { on: vi.fn(() => vi.fn()) },
    },
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
  Copy: () => <span>copy</span>,
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

function createVideoToolGroup(): IMessageToolGroup {
  return {
    id: 'tool-group-video',
    msg_id: 'tool-msg-video',
    conversation_id: 'conversation-1',
    type: 'tool_group',
    position: 'left',
    content: [
      {
        call_id: 'call-video',
        description: 'Generated video',
        name: 'GrokVideo',
        render_output_as_markdown: false,
        result_display: {
          artifact_type: 'video',
          title: 'Launch clip',
          url: 'https://cdn.example.com/launch.mp4',
          mime_type: 'video/mp4',
          provider: 'xAI',
          model: 'grok-video',
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

function createHistoryPagination(overrides: Partial<MessageHistoryPagination> = {}): MessageHistoryPagination {
  return {
    hasOlderMessages: false,
    isLoadingOlderMessages: false,
    loadedHistoricalMessages: 1,
    totalHistoricalMessages: 1,
    loadOlderMessages: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mockScrollerGeometry(
  scroller: HTMLElement,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number }
) {
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    writable: true,
    value: geometry.scrollTop,
  });
  Object.defineProperty(scroller, 'scrollHeight', {
    configurable: true,
    value: geometry.scrollHeight,
  });
  Object.defineProperty(scroller, 'clientHeight', {
    configurable: true,
    value: geometry.clientHeight,
  });
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

  it('suppresses a stale empty slot while the conversation runtime is active', () => {
    render(<MessageList emptySlot={<div>stale handoff note</div>} suppressEmptySlot />, {
      wrapper: ({ children }) => <Wrapper messages={[]}>{children}</Wrapper>,
    });

    expect(screen.getByTestId('message-list-skeleton')).toBeInTheDocument();
    expect(screen.queryByText('stale handoff note')).not.toBeInTheDocument();
  });

  it('loads older history when the user scrolls to the top of a long conversation', () => {
    const loadOlderMessages = vi.fn().mockResolvedValue(undefined);
    render(
      <MessageList
        historyPagination={createHistoryPagination({
          hasOlderMessages: true,
          totalHistoricalMessages: 2,
          loadOlderMessages,
        })}
      />,
      {
        wrapper: ({ children }) => <Wrapper>{children}</Wrapper>,
      }
    );

    const scroller = screen.getByTestId('message-list-scroller');
    mockScrollerGeometry(scroller, {
      scrollTop: 0,
      scrollHeight: 1200,
      clientHeight: 600,
    });
    fireEvent.scroll(scroller);

    expect(loadOlderMessages).toHaveBeenCalledTimes(1);
  });

  it('does not request older history when no older page exists', () => {
    const loadOlderMessages = vi.fn().mockResolvedValue(undefined);
    render(<MessageList historyPagination={createHistoryPagination({ loadOlderMessages })} />, {
      wrapper: ({ children }) => <Wrapper>{children}</Wrapper>,
    });

    const scroller = screen.getByTestId('message-list-scroller');
    mockScrollerGeometry(scroller, {
      scrollTop: 0,
      scrollHeight: 1200,
      clientHeight: 600,
    });
    fireEvent.scroll(scroller);

    expect(loadOlderMessages).not.toHaveBeenCalled();
  });

  it('keeps one older-page load active during rapid top scroll events', () => {
    const olderLoad = createDeferred<void>();
    const loadOlderMessages = vi.fn().mockReturnValue(olderLoad.promise);
    render(
      <MessageList
        historyPagination={createHistoryPagination({
          hasOlderMessages: true,
          totalHistoricalMessages: 2,
          loadOlderMessages,
        })}
      />,
      {
        wrapper: ({ children }) => <Wrapper>{children}</Wrapper>,
      }
    );

    const scroller = screen.getByTestId('message-list-scroller');
    mockScrollerGeometry(scroller, {
      scrollTop: 0,
      scrollHeight: 1200,
      clientHeight: 600,
    });
    fireEvent.scroll(scroller);
    fireEvent.scroll(scroller);

    expect(loadOlderMessages).toHaveBeenCalledTimes(1);
  });

  it('renders generated media, html, and markdown report artifacts from the conversation artifact store', async () => {
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
          artifact_id: 'img-artifact-1',
          request_id: 'img-request-1',
          receipt_path: '/tmp/eve-receipts/img-artifact-1.json',
          receipt: {
            provider_response_id: 'xai-response-1',
          },
        },
        created_at: 2,
        updated_at: 2,
      },
      {
        id: 'artifact-2',
        conversation_id: 'conversation-1',
        kind: 'video',
        status: 'active',
        payload: {
          artifact_type: 'video',
          title: 'Launch clip',
          url: 'https://cdn.example.com/launch.mp4',
          mime_type: 'video/mp4',
        },
        created_at: 3,
        updated_at: 3,
      },
      {
        id: 'artifact-3',
        conversation_id: 'conversation-1',
        kind: 'audio',
        status: 'active',
        payload: {
          artifact_type: 'audio',
          title: 'Voice readout',
          url: 'https://cdn.example.com/readout.mp3',
          mime_type: 'audio/mpeg',
        },
        created_at: 4,
        updated_at: 4,
      },
      {
        id: 'artifact-4',
        conversation_id: 'conversation-1',
        kind: 'html',
        status: 'active',
        payload: {
          artifact_type: 'html',
          title: 'Landing page',
          html: '<main><h1>Offer</h1></main>',
          mime_type: 'text/html',
        },
        created_at: 5,
        updated_at: 5,
      },
      {
        id: 'artifact-5',
        conversation_id: 'conversation-1',
        kind: 'file',
        status: 'active',
        payload: {
          artifact_type: 'file',
          title: 'Campaign report',
          mime_type: 'text/markdown',
          content: [
            '| Channel | Next step |',
            '| --- | --- |',
            '| Email | Draft |',
            '',
            '```ts',
            'const ready = true;',
            '```',
          ].join('\n'),
        },
        created_at: 6,
        updated_at: 6,
      },
    ];

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper>{children}</Wrapper>,
    });

    expect(screen.getByTestId('conversation-artifact-media')).toBeInTheDocument();
    expect(screen.getAllByTestId('generated-artifact-card')).toHaveLength(5);
    expect(screen.getByTestId('generated-artifact-image')).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgo=');
    expect(screen.getByText('Hero render')).toBeInTheDocument();
    expect(screen.getByText('xAI · grok-image · image/png')).toBeInTheDocument();
    expect(screen.getByTestId('generated-artifact-receipt')).toHaveTextContent('/tmp/eve-receipts/img-artifact-1.json');
    expect(screen.getByTestId('generated-artifact-receipt')).toHaveTextContent('img-artifact-1');
    expect(screen.getByTestId('generated-artifact-video')).toHaveAttribute('src', 'https://cdn.example.com/launch.mp4');
    expect(screen.getByTestId('generated-artifact-audio')).toHaveAttribute(
      'src',
      'https://cdn.example.com/readout.mp3'
    );
    const htmlArtifact = screen.getByTestId('generated-artifact-html');
    expect(htmlArtifact.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    expect(htmlArtifact.getAttribute('srcdoc')).toContain('<main><h1>Offer</h1></main>');

    const markdownArtifact = screen.getByTestId('generated-artifact-text');
    await waitFor(() => {
      const shadowRoot = markdownArtifact.querySelector('.markdown-shadow')?.shadowRoot;
      expect(shadowRoot?.querySelector('table')).not.toBeNull();
      expect(shadowRoot?.querySelector('code')?.textContent).toContain('const ready = true;');
    });
  });

  it('does not auto-frame source-only html artifacts', () => {
    artifactMock.artifacts = [
      {
        id: 'artifact-source-html',
        conversation_id: 'conversation-1',
        kind: 'html',
        status: 'active',
        payload: {
          artifact_type: 'html',
          title: 'Local landing page',
          path: '/tmp/generated-landing-page.html',
          mime_type: 'text/html',
        },
        created_at: 7,
        updated_at: 7,
      },
    ];

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper>{children}</Wrapper>,
    });

    expect(screen.queryByTestId('generated-artifact-html')).not.toBeInTheDocument();
    expect(screen.getByTestId('generated-artifact-empty')).toBeInTheDocument();
  });

  it('keeps image generation tool results inline instead of collapsing them into the step summary', () => {
    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[createImageToolGroup()]}>{children}</Wrapper>,
    });

    expect(screen.getByText('tool_group')).toBeInTheDocument();
    expect(screen.queryByText('tool_summary')).not.toBeInTheDocument();
  });

  it('keeps generic generated media tool results inline instead of collapsing them into the step summary', () => {
    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[createVideoToolGroup()]}>{children}</Wrapper>,
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

  it('does not render the same generic generated media twice when an artifact card already exists', () => {
    artifactMock.artifacts = [
      {
        id: 'artifact-video',
        conversation_id: 'conversation-1',
        kind: 'video',
        status: 'active',
        payload: {
          artifact_type: 'video',
          title: 'Launch clip',
          url: 'https://cdn.example.com/launch.mp4',
          mime_type: 'video/mp4',
        },
        created_at: 2,
        updated_at: 2,
      },
    ];

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[createVideoToolGroup()]}>{children}</Wrapper>,
    });

    expect(screen.getByTestId('generated-artifact-card')).toBeInTheDocument();
    expect(screen.queryByText('tool_group')).not.toBeInTheDocument();
    expect(screen.getByText('tool_summary')).toBeInTheDocument();
  });

  it('normalizes generic tool result media into the generated artifact contract', () => {
    const resultDisplay = {
      artifact_type: 'audio',
      title: 'Voice readout',
      url: 'https://cdn.example.com/readout.mp3',
      mime_type: 'audio/mpeg',
      provider: 'xAI',
      model: 'grok-tts',
      artifact_id: 'audio-artifact-1',
      request_id: 'tts-request-1',
      receipt_path: '/tmp/eve-receipts/tts-request-1.json',
      receipt: {
        provider_response_id: 'xai-audio-response',
        data_base64: 'AAECAw==',
        download_url: 'https://private.example.com/raw-audio.mp3',
        preview: 'data:audio/mpeg;base64,AAECAw==',
        authorization: 'Bearer CEVE.v2.secret.secret',
        prompt: 'private prompt text',
      },
      residency: {
        requestedPrivacyLane: 'cloud_us',
        effectiveResidency: 'us_cloud',
      },
      tts: {
        voice_id: 'eve',
        text_length: 42,
      },
    } as const;

    const artifact = buildGeneratedArtifactFromToolResult({
      conversation_id: 'conversation-1',
      call_id: 'call-audio',
      created_at: 10,
      name: 'GrokTTS',
      description: 'Read aloud',
      result_display: resultDisplay,
    });

    expect(getToolResultArtifactSourceKeys(resultDisplay)).toEqual([
      'https://cdn.example.com/readout.mp3',
      'audio-artifact-1',
      'tts-request-1',
    ]);
    expect(artifact?.kind).toBe('audio');
    expect(artifact?.payload).toMatchObject({
      artifact_type: 'audio',
      title: 'Voice readout',
      url: 'https://cdn.example.com/readout.mp3',
      mime_type: 'audio/mpeg',
      provider: 'xAI',
      model: 'grok-tts',
      artifact_id: 'audio-artifact-1',
      request_id: 'tts-request-1',
      receipt_path: '/tmp/eve-receipts/tts-request-1.json',
      receipt: {
        provider_response_id: 'xai-audio-response',
        residency: {
          requestedPrivacyLane: 'cloud_us',
          effectiveResidency: 'us_cloud',
        },
        tts: {
          voice_id: 'eve',
          text_length: 42,
        },
        artifact_id: 'audio-artifact-1',
        request_id: 'tts-request-1',
        receipt_path: '/tmp/eve-receipts/tts-request-1.json',
      },
    });
    expect(JSON.stringify(artifact?.payload)).not.toContain('AAECAw==');
    expect(JSON.stringify(artifact?.payload)).not.toContain('private.example.com');
    expect(JSON.stringify(artifact?.payload)).not.toContain('data:audio');
    expect(JSON.stringify(artifact?.payload)).not.toContain('Bearer CEVE');
    expect(JSON.stringify(artifact?.payload)).not.toContain('private prompt text');
  });

  it('does not treat arbitrary JSON tool output as a generated artifact', () => {
    const resultDisplay = { count: 2, status: 'ok' };

    expect(getToolResultArtifactSourceKeys(resultDisplay)).toEqual([]);
    expect(
      buildGeneratedArtifactFromToolResult({
        conversation_id: 'conversation-1',
        call_id: 'call-json',
        created_at: 10,
        name: 'Search',
        result_display: resultDisplay,
      })
    ).toBeUndefined();
    expect(
      buildGeneratedArtifactFromToolResult({
        conversation_id: 'conversation-1',
        call_id: 'call-html-field',
        created_at: 10,
        name: 'Search',
        result_display: { html: '<p>plain tool field</p>' },
      })
    ).toBeUndefined();
    expect(
      buildGeneratedArtifactFromToolResult({
        conversation_id: 'conversation-1',
        call_id: 'call-image-without-source',
        created_at: 10,
        name: 'ImageMetadata',
        result_display: {
          mime_type: 'image/png',
          content: 'metadata only',
        },
      })
    ).toBeUndefined();
  });
});
