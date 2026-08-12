/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IConversationArtifact } from '@/common/adapter/ipcBridge';
import type { IMessageAcpToolCall } from '@/common/chat/chatLib';
import { ELEMENTS_RAIL_SELECT_EVENT } from '@/renderer/utils/workspace/workspaceEvents';

const {
  openPreviewMock,
  runtimeState,
  listArtifactsInvokeMock,
  videoArtifactsListInvokeMock,
  imageArtifactsListInvokeMock,
  imageArtifactPreviewInvokeMock,
  readGeneratedArtifactPreviewInvokeMock,
  getFileMetadataInvokeMock,
  getImageBase64InvokeMock,
  readFileBufferInvokeMock,
  readFileInvokeMock,
  shellOpenFileInvokeMock,
  shellOpenExternalInvokeMock,
  realtimeConnectedHandlers,
  seatRebindHandlers,
} = vi.hoisted(() => ({
  openPreviewMock: vi.fn(),
  runtimeState: {
    isProcessing: false,
    view: { pendingConfirmations: 0 },
  },
  listArtifactsInvokeMock: vi.fn(),
  videoArtifactsListInvokeMock: vi.fn(),
  imageArtifactsListInvokeMock: vi.fn(),
  imageArtifactPreviewInvokeMock: vi.fn(),
  readGeneratedArtifactPreviewInvokeMock: vi.fn(),
  getFileMetadataInvokeMock: vi.fn(),
  getImageBase64InvokeMock: vi.fn(),
  readFileBufferInvokeMock: vi.fn(),
  readFileInvokeMock: vi.fn(),
  shellOpenFileInvokeMock: vi.fn(),
  shellOpenExternalInvokeMock: vi.fn(),
  realtimeConnectedHandlers: new Set<(event: { reconnected?: boolean }) => void>(),
  seatRebindHandlers: new Set<(seatId: string) => void>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string; type?: string }) => options?.name ?? options?.type ?? key,
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      listArtifacts: { invoke: listArtifactsInvokeMock },
      artifactStream: { on: vi.fn(() => () => {}) },
      realtimeConnected: {
        on: (handler: (event: { reconnected?: boolean }) => void) => {
          realtimeConnectedHandlers.add(handler);
          return () => realtimeConnectedHandlers.delete(handler);
        },
      },
    },
    commandEve: {
      videoArtifactsList: { invoke: videoArtifactsListInvokeMock },
      imageArtifactsList: { invoke: imageArtifactsListInvokeMock },
      imageArtifactsChanged: { on: vi.fn(() => () => {}) },
      imageArtifactPreview: { invoke: imageArtifactPreviewInvokeMock },
    },
    application: {
      readGeneratedArtifactPreview: { invoke: readGeneratedArtifactPreviewInvokeMock },
    },
    fs: {
      getFileMetadata: { invoke: getFileMetadataInvokeMock },
      getImageBase64: { invoke: getImageBase64InvokeMock },
      readFileBuffer: { invoke: readFileBufferInvokeMock },
      readFile: { invoke: readFileInvokeMock },
    },
    shell: {
      openFile: { invoke: shellOpenFileInvokeMock },
      openExternal: { invoke: shellOpenExternalInvokeMock },
    },
  },
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    onSeatRebind: (handler: (seatId: string) => void) => {
      seatRebindHandlers.add(handler);
      return () => seatRebindHandlers.delete(handler);
    },
  },
}));

vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => runtimeState,
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({
    tabs: [],
    openPreview: openPreviewMock,
  }),
}));

import ShellElementsRail from '@/renderer/components/layout/Titlebar/ShellElementsRail';
import { stageConversationArtifact } from '@/renderer/pages/conversation/Messages/artifacts';
import {
  bindConversationDelegationActivitySession,
  publishConversationDelegationActivity,
  publishLiveConversationDelegationActivity,
  resetConversationDelegationActivityForTest,
} from '@/renderer/pages/conversation/runtime/conversationDelegationActivityStore';

const managedImageArtifact: IConversationArtifact = {
  id: 'img-1',
  conversation_id: 'conv-1',
  kind: 'image',
  status: 'active',
  payload: {
    artifact_type: 'image',
    title: 'Wettbewerbsanalyse.png',
    managed_image: true,
  },
  created_at: 1000,
  updated_at: 1000,
};

const videoArtifact: IConversationArtifact = {
  id: 'video-1',
  conversation_id: 'conv-1',
  kind: 'video',
  status: 'active',
  payload: {
    artifact_type: 'video',
    title: 'Video 720p',
    path: '/tmp/Command EVE Videos/conv-1/video-1.mp4',
    mime_type: 'video/mp4',
  },
  created_at: 2000,
  updated_at: 2000,
};

const liveDelegationMessage = (sessionId: string, toolCallId: string, goal: string): IMessageAcpToolCall =>
  ({
    id: `${toolCallId}-message`,
    type: 'acp_tool_call',
    conversation_id: 'conv-1',
    created_at: 250,
    content: {
      session_id: sessionId,
      update: {
        sessionUpdate: 'tool_call',
        tool_call_id: toolCallId,
        status: 'in_progress',
        title: `delegate: ${goal}`,
        kind: 'execute',
        rawInput: { goal },
      },
    },
  }) as IMessageAcpToolCall;

const publishBoundLiveDelegation = (conversationId: string, message: IMessageAcpToolCall): void => {
  bindConversationDelegationActivitySession(conversationId, message.content.session_id);
  publishLiveConversationDelegationActivity(conversationId, message);
};

describe('ShellElementsRail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeState.isProcessing = false;
    runtimeState.view.pendingConfirmations = 0;
    listArtifactsInvokeMock.mockResolvedValue([]);
    videoArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [] });
    imageArtifactsListInvokeMock.mockResolvedValue({ success: true, data: [] });
    imageArtifactPreviewInvokeMock.mockResolvedValue({
      success: true,
      data: { mime_type: 'image/png', data_base64: 'aGVsbG8=' },
    });
    readGeneratedArtifactPreviewInvokeMock.mockResolvedValue(null);
    getFileMetadataInvokeMock.mockResolvedValue(null);
    getImageBase64InvokeMock.mockResolvedValue(null);
    readFileBufferInvokeMock.mockResolvedValue(null);
    readFileInvokeMock.mockResolvedValue(null);
    shellOpenFileInvokeMock.mockResolvedValue(undefined);
    shellOpenExternalInvokeMock.mockResolvedValue(undefined);
    resetConversationDelegationActivityForTest();
  });

  it('shows truthful ready state and an empty artifact state without invented work', async () => {
    render(<ShellElementsRail conversationId='conv-1' conversationTitle='Neuer Chat' />);

    expect(screen.getByText('conversation.elementsRail.ready')).toBeTruthy();
    fireEvent.click(screen.getByTestId('elements-rail-tab-artifacts'));
    expect(screen.getByText('conversation.elementsRail.noArtifacts')).toBeTruthy();
    // The shared store was queried for THIS conversation, not preview tabs.
    await waitFor(() => expect(listArtifactsInvokeMock).toHaveBeenCalledWith({ conversation_id: 'conv-1' }));
  });

  it('exposes one keyboard-operable tablist and labels its panel', () => {
    render(<ShellElementsRail conversationId='conv-1' />);

    const activityTab = screen.getByTestId('elements-rail-tab-activity');
    const artifactsTab = screen.getByTestId('elements-rail-tab-artifacts');
    const panel = screen.getByRole('tabpanel');

    expect(activityTab).toHaveAttribute('aria-controls', 'elements-rail-panel');
    expect(panel).toHaveAttribute('aria-labelledby', 'elements-rail-tab-activity');
    fireEvent.keyDown(activityTab, { key: 'ArrowRight' });
    expect(artifactsTab).toHaveAttribute('aria-selected', 'true');
    expect(panel).toHaveAttribute('aria-labelledby', 'elements-rail-tab-artifacts');
  });

  it("shows only this conversation's Hermes activity and opens its detail without creating a second chat", () => {
    const delegateMessage = (conversationId: string, toolCallId: string, goal: string) =>
      ({
        id: `${toolCallId}-message`,
        type: 'acp_tool_call',
        conversation_id: conversationId,
        created_at: 100,
        content: {
          session_id: conversationId,
          update: {
            sessionUpdate: 'tool_call',
            tool_call_id: toolCallId,
            status: 'in_progress',
            title: `delegate: ${goal}`,
            kind: 'execute',
            rawInput: { goal },
          },
        },
      }) as IMessageAcpToolCall;

    act(() => {
      publishConversationDelegationActivity('conv-1', [delegateMessage('conv-1', 'tc-1', 'Prüfe den Browser')]);
      publishConversationDelegationActivity('conv-2', [delegateMessage('conv-2', 'tc-2', 'Fremder Auftrag')]);
    });

    render(<ShellElementsRail conversationId='conv-1' />);

    expect(screen.getAllByText('Prüfe den Browser')).toHaveLength(2);
    expect(screen.queryByText('Fremder Auftrag')).toBeNull();
    expect(screen.getByText('conversation.durableWork.status.reconnect_unavailable')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'conversation.durableWork.action.open' }));
    expect(openPreviewMock).toHaveBeenCalledWith('legacy:tc-1:0', 'durable-work', {
      title: 'Prüfe den Browser',
      conversation_id: 'conv-1',
    });
  });

  it('projects a renderer-observed live delegation as running without reading that state from chat history', () => {
    act(() => {
      publishBoundLiveDelegation('conv-1', liveDelegationMessage('session-a', 'tc-live', 'Observe the live worker'));
    });

    render(<ShellElementsRail conversationId='conv-1' />);

    expect(screen.getAllByText('Observe the live worker')).toHaveLength(2);
    expect(screen.getByText('conversation.durableWork.status.running')).toBeTruthy();
    expect(screen.queryByText('conversation.durableWork.status.reconnect_unavailable')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('invalidates observed worker A on reconnect before admitting a new ACP session B', () => {
    act(() => {
      publishBoundLiveDelegation('conv-1', liveDelegationMessage('session-a', 'tc-a', 'Worker A'));
    });
    render(<ShellElementsRail conversationId='conv-1' />);
    expect(screen.getByText('conversation.durableWork.status.running')).toBeTruthy();

    act(() => {
      realtimeConnectedHandlers.forEach((handler) => handler({ reconnected: true }));
      publishBoundLiveDelegation('conv-1', liveDelegationMessage('session-b', 'tc-b', 'Worker B'));
    });

    expect(screen.getAllByText('Worker A')).toHaveLength(2);
    expect(screen.getByText('conversation.durableWork.status.reconnect_unavailable')).toBeTruthy();
    expect(screen.getAllByText('Worker B')).toHaveLength(2);
    expect(screen.getByText('conversation.durableWork.status.running')).toBeTruthy();
  });

  it('downgrades observed workers on seat rotation instead of retaining a live state', () => {
    act(() => {
      publishBoundLiveDelegation('conv-1', liveDelegationMessage('session-a', 'tc-seat', 'Seat worker'));
    });
    render(<ShellElementsRail conversationId='conv-1' />);
    expect(screen.getByText('conversation.durableWork.status.running')).toBeTruthy();

    act(() => {
      seatRebindHandlers.forEach((handler) => handler('seat-b'));
    });

    expect(screen.getByText('conversation.durableWork.status.reconnect_unavailable')).toBeTruthy();
    expect(screen.queryByText('conversation.durableWork.status.running')).toBeNull();
  });

  it('keeps another conversation live across a conversation-scoped ACP session rotation', () => {
    act(() => {
      publishBoundLiveDelegation('conv-1', liveDelegationMessage('session-a', 'tc-a', 'Worker A'));
      publishBoundLiveDelegation('conv-2', {
        ...liveDelegationMessage('session-b', 'tc-b', 'Worker B'),
        conversation_id: 'conv-2',
      } as IMessageAcpToolCall);
      publishBoundLiveDelegation('conv-1', liveDelegationMessage('session-a-rotated', 'tc-a2', 'Worker A2'));
    });

    render(<ShellElementsRail conversationId='conv-2' />);
    expect(screen.getAllByText('Worker B')).toHaveLength(2);
    expect(screen.getByText('conversation.durableWork.status.running')).toBeTruthy();
    expect(screen.queryByText('conversation.durableWork.status.reconnect_unavailable')).toBeNull();
  });

  it('downgrades every observed worker on global reconnect and seat rebind', () => {
    act(() => {
      publishBoundLiveDelegation('conv-1', liveDelegationMessage('session-a', 'tc-global-a', 'Worker A'));
      publishBoundLiveDelegation('conv-2', {
        ...liveDelegationMessage('session-b', 'tc-global-b', 'Worker B'),
        conversation_id: 'conv-2',
      } as IMessageAcpToolCall);
      realtimeConnectedHandlers.forEach((handler) => handler({ reconnected: true }));
    });

    const { rerender } = render(<ShellElementsRail conversationId='conv-1' />);
    expect(screen.getByText('conversation.durableWork.status.reconnect_unavailable')).toBeTruthy();
    rerender(<ShellElementsRail conversationId='conv-2' />);
    expect(screen.getByText('conversation.durableWork.status.reconnect_unavailable')).toBeTruthy();

    act(() => {
      publishBoundLiveDelegation('conv-1', liveDelegationMessage('session-a2', 'tc-seat-a', 'Worker A2'));
      publishBoundLiveDelegation('conv-2', {
        ...liveDelegationMessage('session-b2', 'tc-seat-b', 'Worker B2'),
        conversation_id: 'conv-2',
      } as IMessageAcpToolCall);
      seatRebindHandlers.forEach((handler) => handler('seat-c'));
    });

    rerender(<ShellElementsRail conversationId='conv-1' />);
    expect(screen.getAllByText('conversation.durableWork.status.reconnect_unavailable')).toHaveLength(2);
    rerender(<ShellElementsRail conversationId='conv-2' />);
    expect(screen.getAllByText('conversation.durableWork.status.reconnect_unavailable')).toHaveLength(2);
  });

  it('lists shared conversation artifacts and opens a managed image through the preview path', async () => {
    const onRequestClose = vi.fn();
    listArtifactsInvokeMock.mockResolvedValue([managedImageArtifact]);

    render(<ShellElementsRail conversationId='conv-1' onRequestClose={onRequestClose} />);
    fireEvent.click(screen.getByTestId('elements-rail-tab-artifacts'));

    const artifactButton = await screen.findByRole('button', { name: 'Wettbewerbsanalyse.png' });
    fireEvent.click(artifactButton);

    // Managed images carry no path: bytes are resolved by artifact id, then
    // shown in the SAME preview panel the rail always used.
    await waitFor(() =>
      expect(openPreviewMock).toHaveBeenCalledWith(
        'data:image/png;base64,aGVsbG8=',
        'image',
        expect.objectContaining({
          title: 'Wettbewerbsanalyse.png',
          file_name: 'Wettbewerbsanalyse.png',
          conversation_id: 'conv-1',
        })
      )
    );
    expect(imageArtifactPreviewInvokeMock).toHaveBeenCalledWith({ conversationId: 'conv-1', artifactId: 'img-1' });
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it('refreshes reactively when a managed artifact is staged after mount', async () => {
    render(<ShellElementsRail conversationId='conv-1' />);
    fireEvent.click(screen.getByTestId('elements-rail-tab-artifacts'));
    expect(screen.getByText('conversation.elementsRail.noArtifacts')).toBeTruthy();

    act(() => {
      stageConversationArtifact('conv-1', videoArtifact);
      // A different conversation's artifact must never leak into this rail.
      stageConversationArtifact('conv-2', { ...managedImageArtifact, conversation_id: 'conv-2' });
    });

    expect(await screen.findByText('Video 720p')).toBeTruthy();
    expect(screen.queryByText('Wettbewerbsanalyse.png')).toBeNull();
  });

  it('opens a generated video inside the conversation workbench', async () => {
    const onRequestClose = vi.fn();
    listArtifactsInvokeMock.mockResolvedValue([videoArtifact]);
    readGeneratedArtifactPreviewInvokeMock.mockResolvedValue({
      data: 'AAAAHGZ0eXBpc29t',
      encoding: 'base64',
      mimeType: 'video/mp4',
      size: 12,
    });

    render(<ShellElementsRail conversationId='conv-1' onRequestClose={onRequestClose} />);
    fireEvent.click(screen.getByTestId('elements-rail-tab-artifacts'));

    fireEvent.click(await screen.findByRole('button', { name: 'Video 720p' }));

    await waitFor(() =>
      expect(openPreviewMock).toHaveBeenCalledWith(
        'data:video/mp4;base64,AAAAHGZ0eXBpc29t',
        'video',
        expect.objectContaining({
          title: 'Video 720p',
          file_name: 'Video 720p.mp4',
          file_path: '/tmp/Command EVE Videos/conv-1/video-1.mp4',
          conversation_id: 'conv-1',
        })
      )
    );
    expect(shellOpenFileInvokeMock).not.toHaveBeenCalled();
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'inline HTML',
      {
        ...managedImageArtifact,
        id: 'html-1',
        kind: 'html' as const,
        payload: { artifact_type: 'html', title: 'Report.html', html: '<main>Report</main>' },
      },
      '<main>Report</main>',
      'html',
    ],
    [
      'inline Markdown',
      {
        ...managedImageArtifact,
        id: 'markdown-1',
        kind: 'file' as const,
        payload: { artifact_type: 'file', title: 'Notes.md', content: '# Notes' },
      },
      '# Notes',
      'markdown',
    ],
    [
      'remote audio',
      {
        ...managedImageArtifact,
        id: 'audio-1',
        kind: 'audio' as const,
        payload: { artifact_type: 'audio', title: 'Briefing.mp3', audio_url: 'https://cdn.example/briefing.mp3' },
      },
      'https://cdn.example/briefing.mp3',
      'audio',
    ],
    [
      'remote report',
      {
        ...managedImageArtifact,
        id: 'remote-1',
        kind: 'file' as const,
        payload: { artifact_type: 'file', title: 'Research', url: 'https://example.com/research' },
      },
      'https://example.com/research',
      'url',
    ],
  ])('routes %s artifacts into a workbench tab', async (_label, artifact, content, contentType) => {
    listArtifactsInvokeMock.mockResolvedValue([artifact]);

    render(<ShellElementsRail conversationId='conv-1' />);
    fireEvent.click(screen.getByTestId('elements-rail-tab-artifacts'));
    fireEvent.click(await screen.findByRole('button', { name: (artifact.payload as { title: string }).title }));

    await waitFor(() =>
      expect(openPreviewMock).toHaveBeenCalledWith(
        content,
        contentType,
        expect.objectContaining({ conversation_id: 'conv-1' })
      )
    );
  });

  it('opens PDF and Office artifacts in their existing workbench viewers', async () => {
    const artifacts: IConversationArtifact[] = [
      {
        ...managedImageArtifact,
        id: 'pdf-1',
        kind: 'file',
        payload: { artifact_type: 'file', title: 'Report.pdf', path: '/tmp/Report.pdf' },
      },
      {
        ...managedImageArtifact,
        id: 'word-1',
        kind: 'file',
        payload: { artifact_type: 'file', title: 'Brief.docx', path: '/tmp/Brief.docx' },
      },
    ];
    listArtifactsInvokeMock.mockResolvedValue(artifacts);

    render(<ShellElementsRail conversationId='conv-1' />);
    fireEvent.click(screen.getByTestId('elements-rail-tab-artifacts'));
    fireEvent.click(await screen.findByRole('button', { name: 'Report.pdf' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Brief.docx' }));

    expect(openPreviewMock).toHaveBeenNthCalledWith(
      1,
      '',
      'pdf',
      expect.objectContaining({ file_path: '/tmp/Report.pdf' })
    );
    expect(openPreviewMock).toHaveBeenNthCalledWith(
      2,
      '',
      'word',
      expect.objectContaining({ file_path: '/tmp/Brief.docx' })
    );
  });

  it('switches to project context when the composer requests it', () => {
    render(
      <ShellElementsRail
        conversationId='conv-1'
        workspacePath='/tmp/Produkt-Roadmap'
        contextContent={<span>roadmap.md</span>}
      />
    );

    act(() => {
      window.dispatchEvent(new CustomEvent(ELEMENTS_RAIL_SELECT_EVENT, { detail: 'context' }));
    });

    expect(screen.getByText('Produkt-Roadmap')).toBeTruthy();
    expect(screen.getByText('roadmap.md')).toBeTruthy();
  });
});
