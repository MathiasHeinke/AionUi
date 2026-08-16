/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { type PropsWithChildren } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IConversationArtifact } from '@/common/adapter/ipcBridge';
import type { IMessageAcpToolCall, IMessageText, IMessageToolGroup, TMessage } from '@/common/chat/chatLib';
import type { MessageHistoryPagination } from '@/renderer/pages/conversation/Messages/hooks';
import { MessageListLoadingProvider, MessageListProvider } from '@/renderer/pages/conversation/Messages/hooks';
import MessageList from '@/renderer/pages/conversation/Messages/MessageList';
import { parseHermesMediaDirectives } from '@/renderer/pages/conversation/Messages/hermesMediaDirectiveCore';
import {
  buildGeneratedArtifactFromToolResult,
  getToolResultArtifactSourceKeys,
  hasToolResultGeneratedArtifact,
} from '@/renderer/pages/conversation/Messages/types';
import {
  canResolveWorkbenchArtifact,
  openWorkbenchArtifact,
  resetWorkbenchArtifactResolversForTest,
} from '@/renderer/pages/conversation/Preview/services/workbenchArtifactResolver';
import { typedUIFixture } from '../command-eve/typed-ui/fixtures';

const artifactMock = vi.hoisted(() => ({
  artifacts: [] as IConversationArtifact[],
  stage: vi.fn(),
}));
const conversationContextMock = vi.hoisted(() => ({
  current: { conversation_id: 'conversation-1', workspace: '/tmp' } as {
    conversation_id: string;
    workspace: string;
  } | null,
}));
const ipcMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  readFileBuffer: vi.fn(),
  getImageBase64: vi.fn(),
  getFileMetadata: vi.fn(),
  readGeneratedArtifactPreview: vi.fn(),
  attestTypedUI: vi.fn(),
}));
const previewMock = vi.hoisted(() => ({ openPreview: vi.fn() }));
const seatMock = vi.hoisted(() => ({
  current: 'seat-a',
  listeners: new Set<(seatId: string) => void>(),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    getCurrentSeatId: () => seatMock.current,
    get: async () => undefined,
    whenReady: async () => {},
    onSeatRebind: (listener: (seatId: string) => void) => {
      seatMock.listeners.add(listener);
      return () => seatMock.listeners.delete(listener);
    },
  },
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
    useMessage: () => [{ error: vi.fn(), success: vi.fn() }, null],
  },
  Image: {
    PreviewGroup: ({ children }: PropsWithChildren) => <>{children}</>,
  },
  Alert: ({ title, content }: { title?: React.ReactNode; content?: React.ReactNode }) => <div>{title || content}</div>,
  Button: ({ children }: PropsWithChildren) => <button type='button'>{children}</button>,
  Progress: () => <span>progress</span>,
  Spin: () => <span>loading</span>,
  Tag: ({ children }: PropsWithChildren) => <span>{children}</span>,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    shell: {
      openFile: { invoke: vi.fn() },
      openExternal: { invoke: vi.fn() },
      showItemInFolder: { invoke: vi.fn() },
    },
    fs: {
      readFile: { invoke: ipcMock.readFile },
      readFileBuffer: { invoke: ipcMock.readFileBuffer },
      getImageBase64: { invoke: ipcMock.getImageBase64 },
      getFileMetadata: { invoke: ipcMock.getFileMetadata },
    },
    application: {
      readGeneratedArtifactPreview: { invoke: ipcMock.readGeneratedArtifactPreview },
    },
    commandEve: {
      typedUIProvenanceAttestation: { invoke: ipcMock.attestTypedUI },
    },
    theme: {
      requestCurrent: { invoke: vi.fn().mockResolvedValue(null) },
      changed: { on: vi.fn(() => vi.fn()) },
    },
  },
}));

vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => conversationContextMock.current,
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => previewMock,
}));

vi.mock('@/renderer/hooks/file/useAutoPreviewOfficeFiles', () => ({
  useAutoPreviewOfficeFiles: () => {},
}));

vi.mock('@/renderer/pages/conversation/Messages/artifacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/renderer/pages/conversation/Messages/artifacts')>();
  return {
    ...actual,
    useConversationArtifacts: () => artifactMock.artifacts,
    stageConversationArtifact: artifactMock.stage,
  };
});

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

vi.mock('@/renderer/pages/conversation/Preview/components/viewers/PDFViewer', () => ({
  default: ({ file_path, content }: { file_path?: string; content?: string }) => (
    <div data-testid='pdf-preview-inner' data-file-path={file_path} data-content={content} />
  ),
}));

vi.mock('@icon-park/react', () => ({
  Copy: () => <span>copy</span>,
  Down: () => <span>down</span>,
  EditOne: () => <span>edit-one</span>,
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

function createImageToolGroup(status: IMessageToolGroup['content'][number]['status'] = 'Success'): IMessageToolGroup {
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
        status,
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

function typedUIAttestationResponse(artifact: {
  artifact_id: string;
  conversation_id: string;
  source_message_id: string;
}) {
  return {
    success: true,
    data: {
      version: 'command-eve.typed-ui-provenance-attestation/v2',
      attestation_id: `tuia_${'a'.repeat(64)}`,
      artifact_id: artifact.artifact_id,
      conversation_id: artifact.conversation_id,
      source_message_id: artifact.source_message_id,
      content_sha256: 'b'.repeat(64),
      action_set_sha256: 'c'.repeat(64),
      identity_sha256: 'd'.repeat(64),
      request_id_sha256: 'e'.repeat(64),
      receipt_sha256: 'f'.repeat(64),
      seat_context_revision: 1,
      status: 'verified' as const,
      recorded_at: '2026-08-12T00:00:00.000Z',
    },
  };
}

function rebindSeat(seatId: string): void {
  seatMock.current = seatId;
  for (const listener of seatMock.listeners) listener(seatId);
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
    artifactMock.stage.mockReset();
    conversationContextMock.current = { conversation_id: 'conversation-1', workspace: '/tmp' };
    ipcMock.readFile.mockReset();
    ipcMock.readFileBuffer.mockReset();
    ipcMock.getImageBase64.mockReset();
    ipcMock.getFileMetadata.mockReset();
    ipcMock.readGeneratedArtifactPreview.mockReset();
    ipcMock.attestTypedUI.mockReset();
    previewMock.openPreview.mockReset();
    resetWorkbenchArtifactResolversForTest();
    seatMock.current = 'seat-a';
    seatMock.listeners.clear();
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

  it('suppresses the message-derived video card once a hydrated durable record covers its URL', async () => {
    // MAT-1773 (Package B): the hydration reconcile downloaded the CDN clip —
    // the durable record (local path + source_url marker) plays; the card
    // re-derived from the message's MEDIA directive must NOT render a second,
    // dead-URL shell beside it.
    const url = 'https://cdn.example.com/videos/clip.mp4?sig=1';
    artifactMock.artifacts = [
      {
        id: 'hydrated-1',
        conversation_id: 'conversation-1',
        kind: 'video',
        status: 'active',
        payload: {
          artifact_type: 'video',
          title: 'clip.mp4',
          path: '/Users/eve/Downloads/Command EVE Videos/conversation-1/hydrated-1.mp4',
          mime_type: 'video/mp4',
          source_url: url,
        },
        created_at: 3,
        updated_at: 3,
      } as never,
    ];
    const message: IMessageText = {
      ...createTextMessage(),
      content: {
        content: ['Dein Video ist fertig:', '', `MEDIA: ${url}`].join('\n'),
      },
    };

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[message]}>{children}</Wrapper>,
    });

    const cards = screen.getAllByTestId('generated-artifact-card');
    expect(cards).toHaveLength(1);
    expect(screen.getByText('clip.mp4')).toBeInTheDocument();
  });

  it('keeps a Main-durable Office record authoritative over the renderer MEDIA projection with the same id', () => {
    artifactMock.artifacts = [
      {
        id: 'hermes-media-message-1-0',
        conversation_id: 'conversation-1',
        kind: 'file',
        status: 'active',
        payload: {
          artifact_type: 'file',
          title: 'Durable.docx',
          path: '.command-eve/conversation-artifacts/conv/durable.docx',
          managed_office: true,
          source_message_id: 'message-1',
          source_directive_index: 0,
        },
        created_at: 3,
        updated_at: 3,
      } as never,
    ];
    const message: IMessageText = {
      ...createTextMessage(),
      content: { content: 'Fertig.\nMEDIA: /tmp/renderer-authored.docx' },
    };

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[message]}>{children}</Wrapper>,
    });

    expect(screen.getAllByTestId('generated-artifact-card')).toHaveLength(1);
    expect(screen.getByText('Durable.docx')).toBeInTheDocument();
    expect(screen.queryByText('renderer-authored.docx')).not.toBeInTheDocument();
    expect(artifactMock.stage).not.toHaveBeenCalled();
  });

  it('renders an assistant Hermes MEDIA directive as a visible file artifact', async () => {
    ipcMock.getFileMetadata.mockRejectedValue(new Error('outside workspace'));
    ipcMock.readGeneratedArtifactPreview.mockResolvedValue({
      data: 'JVBERi0=',
      encoding: 'base64',
      mimeType: 'application/pdf',
      size: 1024,
    });
    const message: IMessageText = {
      ...createTextMessage(),
      content: {
        content: [
          'Die PDF ist fertig und liegt im Downloads-Ordner.',
          '',
          '**MEDIA:** /Users/eve/Downloads/command eve output.pdf',
        ].join('\n'),
      },
    };

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[message]}>{children}</Wrapper>,
    });

    expect(screen.getByText('Die PDF ist fertig und liegt im Downloads-Ordner.')).toBeInTheDocument();
    expect(screen.queryByText(/MEDIA:/)).not.toBeInTheDocument();
    expect(screen.getByTestId('generated-artifact-card')).toBeInTheDocument();
    expect(screen.getByText('command eve output.pdf')).toBeInTheDocument();
    expect(screen.getByTestId('generated-artifact-open')).toBeInTheDocument();
    expect(screen.getByTestId('generated-artifact-reveal')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('generated-artifact-pdf')).toBeInTheDocument());
    expect(screen.getByTestId('pdf-preview-inner')).toHaveAttribute(
      'data-content',
      'data:application/pdf;base64,JVBERi0='
    );
    expect(ipcMock.getFileMetadata).toHaveBeenCalledWith({
      path: '/Users/eve/Downloads/command eve output.pdf',
      workspace: '/tmp',
    });
    expect(ipcMock.readGeneratedArtifactPreview).toHaveBeenCalledWith({
      path: '/Users/eve/Downloads/command eve output.pdf',
      kind: 'pdf',
    });
    expect(ipcMock.readFileBuffer).not.toHaveBeenCalled();
  });

  it('loads a generated Downloads HTML artifact through the bounded desktop bridge', async () => {
    ipcMock.getFileMetadata.mockRejectedValue(new Error('outside workspace'));
    ipcMock.readGeneratedArtifactPreview.mockResolvedValue({
      data: '<main><h1>Command EVE report</h1></main>',
      encoding: 'utf8',
      mimeType: 'text/html',
      size: 41,
    });
    const message: IMessageText = {
      ...createTextMessage(),
      content: {
        content: 'MEDIA: /Users/eve/Downloads/command-eve-report.html',
      },
    };

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[message]}>{children}</Wrapper>,
    });

    await waitFor(() => expect(screen.getByTestId('generated-artifact-html')).toBeInTheDocument());
    await waitFor(() =>
      expect(artifactMock.stage).toHaveBeenCalledWith(
        'conversation-1',
        expect.objectContaining({
          id: 'hermes-media-message-1-0',
          conversation_id: 'conversation-1',
          kind: 'html',
          payload: expect.objectContaining({
            artifact_type: 'html',
            path: '/Users/eve/Downloads/command-eve-report.html',
          }),
        })
      )
    );
    const htmlArtifact = screen.getByTestId('generated-artifact-html');
    expect(htmlArtifact.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    expect(htmlArtifact.getAttribute('srcdoc')).toContain('<main><h1>Command EVE report</h1></main>');
    expect(ipcMock.readGeneratedArtifactPreview).toHaveBeenCalledWith({
      path: '/Users/eve/Downloads/command-eve-report.html',
      kind: 'html',
    });
    expect(ipcMock.readFile).not.toHaveBeenCalled();
  });

  it('does not promote user or unsafe MEDIA text into an artifact', () => {
    const userMessage: IMessageText = {
      ...createTextMessage(),
      id: 'message-user',
      position: 'right',
      content: { content: 'MEDIA:/Users/eve/Downloads/user-file.pdf' },
    };
    const unsafeAssistantMessage: IMessageText = {
      ...createTextMessage(),
      id: 'message-unsafe',
      content: { content: 'MEDIA:../../private/report.pdf' },
    };

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[userMessage, unsafeAssistantMessage]}>{children}</Wrapper>,
    });

    expect(screen.queryByTestId('generated-artifact-card')).not.toBeInTheDocument();
    expect(artifactMock.stage).not.toHaveBeenCalled();
    expect(screen.getByText('MEDIA:/Users/eve/Downloads/user-file.pdf')).toBeInTheDocument();
    expect(screen.getByText('MEDIA:../../private/report.pdf')).toBeInTheDocument();
  });

  it('deduplicates valid Hermes MEDIA directives while retaining unsupported lines', () => {
    const parsed = parseHermesMediaDirectives(
      [
        'Bereit.',
        'MEDIA:/tmp/final.pdf',
        'MEDIA:/tmp/final.pdf',
        'MEDIA:http://example.com/insecure.pdf',
        'MEDIA:/tmp/no-extension',
      ].join('\n')
    );

    expect(parsed.directives).toEqual([
      {
        source: '/tmp/final.pdf',
        artifactType: 'file',
        title: 'final.pdf',
      },
    ]);
    expect(parsed.text).toContain('MEDIA:http://example.com/insecure.pdf');
    expect(parsed.text).toContain('MEDIA:/tmp/no-extension');
  });

  it('recovers a MEDIA artifact when streamed prose is joined directly after the extension', () => {
    const parsed = parseHermesMediaDirectives(
      '**MEDIA:** /Users/eve/Downloads/final.pdfDie PDF liegt fertig im Downloads-Ordner.'
    );

    expect(parsed.directives).toEqual([
      {
        source: '/Users/eve/Downloads/final.pdf',
        artifactType: 'file',
        title: 'final.pdf',
      },
    ]);
    expect(parsed.text).toBe('Die PDF liegt fertig im Downloads-Ordner.');
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

  it('shows immediate runtime activity instead of a blank loading history', () => {
    render(
      <MessageList
        emptySlot={<div>stale handoff note</div>}
        suppressEmptySlot
        tailSlot={<div data-testid='pending-runtime-activity'>EVE is preparing the task</div>}
      />,
      {
        wrapper: ({ children }) => <Wrapper messages={[]}>{children}</Wrapper>,
      }
    );

    expect(screen.getByTestId('pending-runtime-activity')).toBeInTheDocument();
    expect(screen.queryByTestId('message-list-skeleton')).not.toBeInTheDocument();
    expect(screen.queryByText('stale handoff note')).not.toBeInTheDocument();
  });

  it('places runtime activity after an existing conversation message', () => {
    render(<MessageList tailSlot={<div data-testid='pending-runtime-activity'>EVE is preparing the task</div>} />, {
      wrapper: ({ children }) => <Wrapper>{children}</Wrapper>,
    });

    const message = screen.getByText('streaming reply');
    const activity = screen.getByTestId('pending-runtime-activity');
    expect(message.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it('loads and securely frames source-only html artifacts', async () => {
    ipcMock.getFileMetadata.mockResolvedValue({
      name: 'generated-landing-page.html',
      path: '/tmp/generated-landing-page.html',
      size: 1024,
      type: 'text/html',
      lastModified: 1,
    });
    ipcMock.readFile.mockResolvedValue('<main><h1>Local offer</h1><script>window.pwned = true</script></main>');
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

    await waitFor(() => expect(screen.getByTestId('generated-artifact-html')).toBeInTheDocument());
    expect(ipcMock.readFile).toHaveBeenCalledWith({ path: '/tmp/generated-landing-page.html', workspace: '/tmp' });
    const htmlArtifact = screen.getByTestId('generated-artifact-html');
    expect(htmlArtifact.getAttribute('sandbox')).toBe('');
    expect(htmlArtifact.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    expect(htmlArtifact.getAttribute('srcdoc')).toContain('<main><h1>Local offer</h1>');
    expect(htmlArtifact.getAttribute('srcdoc')).toContain('window.pwned');
  });

  it('does not read a model-provided local artifact path without an active workspace', async () => {
    conversationContextMock.current = null;
    artifactMock.artifacts = [
      {
        id: 'artifact-unscoped-html',
        conversation_id: 'conversation-1',
        kind: 'html',
        status: 'active',
        payload: { artifact_type: 'html', path: '/tmp/unscoped.html' },
        created_at: 8,
        updated_at: 8,
      },
    ];

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper>{children}</Wrapper>,
    });

    await waitFor(() => expect(screen.getByTestId('generated-artifact-empty')).toBeInTheDocument());
    expect(ipcMock.getFileMetadata).not.toHaveBeenCalled();
    expect(ipcMock.readFile).not.toHaveBeenCalled();
  });

  it('does not read an oversized local html artifact into renderer memory', async () => {
    ipcMock.getFileMetadata.mockResolvedValue({
      name: 'large.html',
      path: '/tmp/large.html',
      size: 2 * 1024 * 1024 + 1,
      type: 'text/html',
      lastModified: 1,
    });
    artifactMock.artifacts = [
      {
        id: 'artifact-large-html',
        conversation_id: 'conversation-1',
        kind: 'html',
        status: 'active',
        payload: { artifact_type: 'html', path: '/tmp/large.html' },
        created_at: 8,
        updated_at: 8,
      },
    ];

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper>{children}</Wrapper>,
    });

    await waitFor(() =>
      expect(ipcMock.getFileMetadata).toHaveBeenCalledWith({ path: '/tmp/large.html', workspace: '/tmp' })
    );
    await waitFor(() => expect(screen.getByTestId('generated-artifact-empty')).toBeInTheDocument());
    expect(ipcMock.readFile).not.toHaveBeenCalled();
    expect(screen.queryByTestId('generated-artifact-html')).not.toBeInTheDocument();
  });

  it('loads local image, audio, and video artifacts through bounded data URLs', async () => {
    ipcMock.getFileMetadata.mockImplementation(async ({ path }: { path: string }) => ({
      name: path.split('/').pop(),
      path,
      size: 1024,
      type: path.endsWith('.mp4') ? 'video/mp4' : path.endsWith('.wav') ? 'audio/wav' : 'image/png',
      lastModified: 1,
    }));
    ipcMock.getImageBase64.mockResolvedValue('data:image/png;base64,aW1hZ2U=');
    ipcMock.readFileBuffer.mockImplementation(async ({ path }: { path: string }) =>
      path.endsWith('.mp4') ? 'dmlkZW8=' : 'YXVkaW8='
    );
    artifactMock.artifacts = [
      {
        id: 'artifact-local-image',
        conversation_id: 'conversation-1',
        kind: 'image',
        status: 'active',
        payload: { artifact_type: 'image', path: '/tmp/eve.png' },
        created_at: 8,
        updated_at: 8,
      },
      {
        id: 'artifact-local-audio',
        conversation_id: 'conversation-1',
        kind: 'audio',
        status: 'active',
        payload: { artifact_type: 'audio', path: '/tmp/eve.wav' },
        created_at: 9,
        updated_at: 9,
      },
      {
        id: 'artifact-local-video',
        conversation_id: 'conversation-1',
        kind: 'video',
        status: 'active',
        payload: { artifact_type: 'video', path: '/tmp/eve.mp4' },
        created_at: 10,
        updated_at: 10,
      },
    ];

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper>{children}</Wrapper>,
    });

    await waitFor(() =>
      expect(screen.getByTestId('generated-artifact-image')).toHaveAttribute('src', 'data:image/png;base64,aW1hZ2U=')
    );
    expect(screen.getByTestId('generated-artifact-audio')).toHaveAttribute('src', 'data:audio/wav;base64,YXVkaW8=');
    expect(screen.getByTestId('generated-artifact-video')).toHaveAttribute('src', 'data:video/mp4;base64,dmlkZW8=');
    expect(ipcMock.getImageBase64).toHaveBeenCalledWith({ path: '/tmp/eve.png', workspace: '/tmp' });
    expect(ipcMock.readFileBuffer).toHaveBeenCalledTimes(2);
  });

  it('does not load an oversized local media artifact into renderer memory', async () => {
    ipcMock.getFileMetadata.mockResolvedValue({
      name: 'large.mp4',
      path: '/tmp/large.mp4',
      size: 48 * 1024 * 1024,
      type: 'video/mp4',
      lastModified: 1,
    });
    artifactMock.artifacts = [
      {
        id: 'artifact-large-video',
        conversation_id: 'conversation-1',
        kind: 'video',
        status: 'active',
        payload: { artifact_type: 'video', path: '/tmp/large.mp4' },
        created_at: 11,
        updated_at: 11,
      },
    ];

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper>{children}</Wrapper>,
    });

    await waitFor(() =>
      expect(ipcMock.getFileMetadata).toHaveBeenCalledWith({ path: '/tmp/large.mp4', workspace: '/tmp' })
    );
    await waitFor(() => expect(screen.getByTestId('generated-artifact-empty')).toBeInTheDocument());
    expect(ipcMock.readFileBuffer).not.toHaveBeenCalled();
    expect(screen.queryByTestId('generated-artifact-video')).not.toBeInTheDocument();
  });

  it('keeps image generation tool results inline instead of collapsing them into the step summary', () => {
    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[createImageToolGroup()]}>{children}</Wrapper>,
    });

    expect(screen.getByText('tool_group')).toBeInTheDocument();
    expect(screen.queryByText('tool_summary')).not.toBeInTheDocument();
  });

  it.each(['Executing', 'Pending', 'Error', 'Canceled', 'Confirming'] as const)(
    'does not classify an image-shaped %s tool result as an inline artifact',
    (status) => {
      render(<MessageList />, {
        wrapper: ({ children }) => <Wrapper messages={[createImageToolGroup(status)]}>{children}</Wrapper>,
      });

      expect(screen.queryByText('tool_group')).not.toBeInTheDocument();
      expect(screen.getByText('tool_summary')).toBeInTheDocument();
    }
  );

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
        status: 'done',
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
        status: 'done',
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

  it.each([
    ['error marker', { error: 'Provider rejected the artifact.' }],
    ['empty error marker', { error: '' }],
    ['failed boolean marker', { failed: true }],
    ['blocked boolean marker', { blocked: true }],
    ['negative ok marker', { ok: false }],
    ['failed receipt', { receipt: { status: 'failed' } }],
    ['blocked receipt', { receipt: { status: 'blocked' } }],
    ['unverified receipt', { receipt: { status: 'unverified' } }],
    [
      'successful-looking receipt error marker',
      { receipt: { status: 'done', error: 'Provider rejected the artifact.' } },
    ],
    [
      'successful-looking receipt failure marker',
      { receipt: { status: 'done', failure: 'Provider rejected the artifact.' } },
    ],
    ['successful-looking receipt negative ok marker', { receipt: { status: 'done', ok: false } }],
    ['successful-looking receipt negative success marker', { receipt: { status: 'done', success: false } }],
    ['successful-looking receipt failed boolean marker', { receipt: { status: 'done', failed: true } }],
    ['successful-looking receipt blocked boolean marker', { receipt: { status: 'done', blocked: true } }],
    ['failed payload status', { status: 'failed' }],
    ['blocked payload status', { status: 'blocked' }],
    ['unverified payload status', { status: 'unverified' }],
    ['pending payload status', { status: 'pending' }],
    ['malformed payload status', { status: { state: 'failed' } }],
  ])('does not classify a contradictory result with a %s as a generated artifact', (_label, contradiction) => {
    const resultDisplay = {
      artifact_type: 'image',
      url: 'https://cdn.example.com/candidate.png',
      mime_type: 'image/png',
      ...contradiction,
    };

    expect(hasToolResultGeneratedArtifact(resultDisplay)).toBe(false);
    expect(
      buildGeneratedArtifactFromToolResult({
        conversation_id: 'conversation-1',
        call_id: 'call-contradictory-artifact',
        created_at: 10,
        name: 'ImageGeneration',
        result_display: resultDisplay,
      })
    ).toBeUndefined();
  });

  it('accepts a terminal successful payload status for an otherwise valid artifact', () => {
    const resultDisplay = {
      artifact_type: 'image',
      url: 'https://cdn.example.com/terminal.png',
      mime_type: 'image/png',
      status: 'done',
    };

    expect(hasToolResultGeneratedArtifact(resultDisplay)).toBe(true);
    expect(
      buildGeneratedArtifactFromToolResult({
        conversation_id: 'conversation-1',
        call_id: 'call-terminal-artifact',
        created_at: 10,
        name: 'ImageGeneration',
        result_display: resultDisplay,
      })
    ).toMatchObject({ kind: 'image', payload: { url: 'https://cdn.example.com/terminal.png' } });
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

  it('carries the backend message identity into a typed tool artifact', () => {
    const artifact = buildGeneratedArtifactFromToolResult({
      conversation_id: 'conversation-typed',
      call_id: 'call-typed',
      source_message_id: 'message-typed',
      created_at: 10,
      name: 'eve_typed_ui_publish',
      result_display: {
        ok: true,
        artifact_type: 'file',
        mime_type: 'application/vnd.command-eve.typed-ui+json',
        content: '{"schema_version":"command-eve.typed-ui/v2"}',
      },
    });

    expect(artifact).toMatchObject({
      id: 'tool-artifact-call-typed',
      conversation_id: 'conversation-typed',
      payload: { source_message_id: 'message-typed' },
    });
  });

  it('keeps a persisted ACP Typed UI result inert until Main attests it, then registers exactly one resolver', async () => {
    const deferred = createDeferred<unknown>();
    let attestationReady = false;
    ipcMock.attestTypedUI.mockImplementation(
      ({ request }: { request: { artifact: Parameters<typeof typedUIAttestationResponse>[0] } }) =>
        attestationReady ? typedUIAttestationResponse(request.artifact) : deferred.promise
    );
    const raw = typedUIFixture();
    const acpMessage = {
      id: 'message-acp-typed',
      msg_id: 'message-acp-typed',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      position: 'left',
      created_at: 10,
      content: {
        session_id: 'session-1',
        update: {
          session_update: 'tool_call_update',
          tool_call_id: 'call-acp-typed',
          status: 'completed',
          title: 'untrusted presentation title',
          kind: 'execute',
          raw_output: {
            ok: true,
            artifact_type: 'file',
            mime_type: 'application/vnd.command-eve.typed-ui+json',
            schema_version: 'command-eve.typed-ui/v2',
            catalog_version: 'command-eve.typed-ui.catalog/v2',
            content: JSON.stringify(raw),
            status: 'completed',
            tool_name: 'mcp__aionui_eve_artifacts__eve_typed_ui_publish',
          },
        },
      },
    } as unknown as IMessageAcpToolCall;

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[acpMessage]}>{children}</Wrapper>,
    });

    const reference = {
      kind: 'chat' as const,
      artifactId: 'tool-artifact-call-acp-typed',
      conversationId: 'conversation-1',
    };
    await waitFor(() => expect(screen.getByTestId('typed-ui-provenance-checking')).toBeInTheDocument());
    expect(screen.queryByTestId('generated-artifact-card')).toBeNull();
    expect(canResolveWorkbenchArtifact(reference)).toBe(false);
    await expect(openWorkbenchArtifact(reference)).rejects.toThrow('artifact_not_resolved');
    expect(previewMock.openPreview).not.toHaveBeenCalled();

    attestationReady = true;
    deferred.resolve(
      typedUIAttestationResponse({
        artifact_id: reference.artifactId,
        conversation_id: reference.conversationId,
        source_message_id: 'message-acp-typed',
      })
    );

    await waitFor(() => expect(screen.getByTestId('generated-artifact-card')).toBeInTheDocument());
    await waitFor(() => expect(canResolveWorkbenchArtifact(reference)).toBe(true));
    await openWorkbenchArtifact(reference);
    expect(previewMock.openPreview).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('acp_tool_call')).toBeNull();
  });

  it('keeps a Main-rejected persisted ACP Typed UI result non-addressable', async () => {
    ipcMock.attestTypedUI.mockImplementation(
      ({
        request,
      }: {
        request: { artifact: { artifact_id: string; conversation_id: string; source_message_id: string } };
      }) => ({
        success: true,
        data: {
          ...typedUIAttestationResponse(request.artifact).data,
          artifact_id: request.artifact.artifact_id,
          conversation_id: request.artifact.conversation_id,
          source_message_id: request.artifact.source_message_id,
          status: 'rejected' as const,
        },
      })
    );
    const acpMessage = {
      id: 'message-acp-rejected',
      msg_id: 'message-acp-rejected',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      position: 'left',
      created_at: 10,
      content: {
        session_id: 'session-1',
        update: {
          session_update: 'tool_call_update',
          tool_call_id: 'call-acp-rejected',
          status: 'completed',
          raw_output: {
            ok: true,
            artifact_type: 'file',
            mime_type: 'application/vnd.command-eve.typed-ui+json',
            schema_version: 'command-eve.typed-ui/v2',
            catalog_version: 'command-eve.typed-ui.catalog/v2',
            content: JSON.stringify(typedUIFixture()),
            status: 'completed',
            tool_name: 'eve_typed_ui_publish',
          },
        },
      },
    } as unknown as IMessageAcpToolCall;

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[acpMessage]}>{children}</Wrapper>,
    });

    await waitFor(() => expect(screen.getByTestId('typed-ui-provenance-rejected')).toBeInTheDocument());
    expect(screen.queryByTestId('generated-artifact-card')).toBeNull();
    expect(
      canResolveWorkbenchArtifact({
        kind: 'chat',
        artifactId: 'tool-artifact-call-acp-rejected',
        conversationId: 'conversation-1',
      })
    ).toBe(false);
  });

  it('revokes a verified Typed UI resolver after seat rebind and rejects its former reference', async () => {
    ipcMock.attestTypedUI.mockImplementation(
      ({ request }: { request: { artifact: Parameters<typeof typedUIAttestationResponse>[0] } }) => {
        const response = typedUIAttestationResponse(request.artifact);
        return seatMock.current === 'seat-b'
          ? { ...response, data: { ...response.data, status: 'rejected' as const, reason: 'seat_context_changed' } }
          : response;
      }
    );
    const acpMessage = {
      id: 'message-acp-seat-rebind',
      msg_id: 'message-acp-seat-rebind',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      position: 'left',
      created_at: 10,
      content: {
        session_id: 'session-1',
        update: {
          session_update: 'tool_call_update',
          tool_call_id: 'call-acp-seat-rebind',
          status: 'completed',
          raw_output: {
            ok: true,
            artifact_type: 'file',
            mime_type: 'application/vnd.command-eve.typed-ui+json',
            schema_version: 'command-eve.typed-ui/v2',
            catalog_version: 'command-eve.typed-ui.catalog/v2',
            content: JSON.stringify(typedUIFixture()),
            status: 'completed',
            tool_name: 'eve_typed_ui_publish',
          },
        },
      },
    } as unknown as IMessageAcpToolCall;
    const reference = {
      kind: 'chat' as const,
      artifactId: 'tool-artifact-call-acp-seat-rebind',
      conversationId: 'conversation-1',
    };

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[acpMessage]}>{children}</Wrapper>,
    });

    await waitFor(() => expect(canResolveWorkbenchArtifact(reference)).toBe(true));
    rebindSeat('seat-b');
    await waitFor(() => expect(canResolveWorkbenchArtifact(reference)).toBe(false));
    await expect(openWorkbenchArtifact(reference)).rejects.toThrow('artifact_not_resolved');
    expect(previewMock.openPreview).not.toHaveBeenCalled();
  });

  it('rejects a re-attestation whose content receipt no longer matches before opening the resolver', async () => {
    let calls = 0;
    ipcMock.attestTypedUI.mockImplementation(
      ({ request }: { request: { artifact: Parameters<typeof typedUIAttestationResponse>[0] } }) => {
        calls += 1;
        const response = typedUIAttestationResponse(request.artifact);
        return calls >= 4 ? { ...response, data: { ...response.data, content_sha256: 'f'.repeat(64) } } : response;
      }
    );
    const acpMessage = {
      id: 'message-acp-content-recheck',
      msg_id: 'message-acp-content-recheck',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      position: 'left',
      created_at: 10,
      content: {
        session_id: 'session-1',
        update: {
          session_update: 'tool_call_update',
          tool_call_id: 'call-acp-content-recheck',
          status: 'completed',
          raw_output: {
            ok: true,
            artifact_type: 'file',
            mime_type: 'application/vnd.command-eve.typed-ui+json',
            schema_version: 'command-eve.typed-ui/v2',
            catalog_version: 'command-eve.typed-ui.catalog/v2',
            content: JSON.stringify(typedUIFixture()),
            status: 'completed',
            tool_name: 'eve_typed_ui_publish',
          },
        },
      },
    } as unknown as IMessageAcpToolCall;
    const reference = {
      kind: 'chat' as const,
      artifactId: 'tool-artifact-call-acp-content-recheck',
      conversationId: 'conversation-1',
    };

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[acpMessage]}>{children}</Wrapper>,
    });

    await waitFor(() => expect(canResolveWorkbenchArtifact(reference)).toBe(true));
    await expect(openWorkbenchArtifact(reference)).rejects.toThrow('artifact_not_resolved');
    expect(previewMock.openPreview).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('typed-ui-provenance-rejected')).toBeInTheDocument());
  });

  it('drops an A-content attestation when the same durable identity rerenders B content', async () => {
    const rawA = typedUIFixture();
    const rawB = structuredClone(rawA);
    (rawB.elements.heading.props as { text: string }).text = 'Different durable content';
    ipcMock.attestTypedUI.mockImplementation(
      ({ request }: { request: { artifact: Parameters<typeof typedUIAttestationResponse>[0]; envelope: unknown } }) => {
        const response = typedUIAttestationResponse(request.artifact);
        return JSON.stringify(request.envelope).includes('Different durable content')
          ? { ...response, data: { ...response.data, status: 'rejected' as const, reason: 'content_mismatch' } }
          : response;
      }
    );
    const acpMessage = {
      id: 'message-acp-content-rerender',
      msg_id: 'message-acp-content-rerender',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      position: 'left',
      created_at: 10,
      content: {
        session_id: 'session-1',
        update: {
          session_update: 'tool_call_update',
          tool_call_id: 'call-acp-content-rerender',
          status: 'completed',
          raw_output: {
            ok: true,
            artifact_type: 'file',
            mime_type: 'application/vnd.command-eve.typed-ui+json',
            schema_version: 'command-eve.typed-ui/v2',
            catalog_version: 'command-eve.typed-ui.catalog/v2',
            content: JSON.stringify(rawA),
            status: 'completed',
            tool_name: 'eve_typed_ui_publish',
          },
        },
      },
    } as unknown as IMessageAcpToolCall;
    const reference = {
      kind: 'chat' as const,
      artifactId: 'tool-artifact-call-acp-content-rerender',
      conversationId: 'conversation-1',
    };
    const { rerender } = render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[acpMessage]}>{children}</Wrapper>,
    });

    await waitFor(() => expect(canResolveWorkbenchArtifact(reference)).toBe(true));
    const changedMessage = structuredClone(acpMessage) as typeof acpMessage;
    changedMessage.content.update.raw_output.content = JSON.stringify(rawB);
    rerender(
      <MessageListLoadingProvider value={false}>
        <MessageListProvider value={[changedMessage]}>
          <MessageList />
        </MessageListProvider>
      </MessageListLoadingProvider>
    );

    expect(canResolveWorkbenchArtifact(reference)).toBe(false);
    await waitFor(() => expect(screen.getByTestId('typed-ui-provenance-rejected')).toBeInTheDocument());
    expect(canResolveWorkbenchArtifact(reference)).toBe(false);
    expect(previewMock.openPreview).not.toHaveBeenCalled();
  });

  it.each([
    ['nonterminal', 'in_progress', JSON.stringify(typedUIFixture()), undefined],
    ['malformed', 'completed', '{', undefined],
    ['extra-key', 'completed', JSON.stringify(typedUIFixture()), { unexpected: true }],
    ['missing-tool-name', 'completed', JSON.stringify(typedUIFixture()), undefined],
    [
      'wrong-tool-name',
      'completed',
      JSON.stringify(typedUIFixture()),
      { tool_name: 'mcp__other__eve_typed_ui_publish' },
    ],
    [
      'oversized',
      'completed',
      JSON.stringify({ ...typedUIFixture(), state: { value: 'x'.repeat(512 * 1024 + 1) } }),
      undefined,
    ],
  ])('keeps %s persisted ACP Typed UI output in the inert tool fallback', async (_label, status, content, extra) => {
    const acpMessage = {
      id: `message-acp-${status}-${_label}`,
      msg_id: `message-acp-${status}-${_label}`,
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      position: 'left',
      created_at: 10,
      content: {
        session_id: 'session-1',
        update: {
          session_update: 'tool_call_update',
          tool_call_id: `call-acp-${status}-${_label}`,
          status,
          title: 'untrusted presentation title',
          kind: 'execute',
          raw_output: {
            ok: true,
            artifact_type: 'file',
            mime_type: 'application/vnd.command-eve.typed-ui+json',
            schema_version: 'command-eve.typed-ui/v2',
            catalog_version: 'command-eve.typed-ui.catalog/v2',
            content,
            ...(status === 'completed' ? { status: 'completed' } : {}),
            ...(_label === 'missing-tool-name' ? {} : { tool_name: 'eve_typed_ui_publish' }),
            ...extra,
          },
        },
      },
    } as unknown as IMessageAcpToolCall;

    render(<MessageList />, {
      wrapper: ({ children }) => <Wrapper messages={[acpMessage]}>{children}</Wrapper>,
    });

    await waitFor(() => expect(screen.getByText('tool_summary')).toBeInTheDocument());
    expect(screen.queryByTestId('conversation-artifact-file')).toBeNull();
  });
});
