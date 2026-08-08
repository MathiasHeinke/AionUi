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
  shellOpenFileInvokeMock,
  shellOpenExternalInvokeMock,
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
  shellOpenFileInvokeMock: vi.fn(),
  shellOpenExternalInvokeMock: vi.fn(),
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
    shell: {
      openFile: { invoke: shellOpenFileInvokeMock },
      openExternal: { invoke: shellOpenExternalInvokeMock },
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
  publishConversationDelegationActivity,
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
    title: 'Produktvideo.mp4',
    path: '/tmp/Command EVE Videos/conv-1/video-1.mp4',
    mime_type: 'video/mp4',
  },
  created_at: 2000,
  updated_at: 2000,
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

  it("shows only this conversation's real Hermes delegation activity without creating a second chat", () => {
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

    expect(screen.getByText('Prüfe den Browser')).toBeTruthy();
    expect(screen.queryByText('Fremder Auftrag')).toBeNull();
    expect(screen.getByText('conversation.elementsRail.delegationStatus.in_progress')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
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
      expect(openPreviewMock).toHaveBeenCalledWith('data:image/png;base64,aGVsbG8=', 'image', {
        title: 'Wettbewerbsanalyse.png',
        file_name: 'Wettbewerbsanalyse.png',
        conversation_id: 'conv-1',
      })
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

    expect(await screen.findByText('Produktvideo.mp4')).toBeTruthy();
    expect(screen.queryByText('Wettbewerbsanalyse.png')).toBeNull();
  });

  it('opens a video artifact through the system viewer path chat artifact cards use', async () => {
    const onRequestClose = vi.fn();
    listArtifactsInvokeMock.mockResolvedValue([videoArtifact]);

    render(<ShellElementsRail conversationId='conv-1' onRequestClose={onRequestClose} />);
    fireEvent.click(screen.getByTestId('elements-rail-tab-artifacts'));

    fireEvent.click(await screen.findByRole('button', { name: 'Produktvideo.mp4' }));

    await waitFor(() =>
      expect(shellOpenFileInvokeMock).toHaveBeenCalledWith('/tmp/Command EVE Videos/conv-1/video-1.mp4')
    );
    expect(openPreviewMock).not.toHaveBeenCalled();
    expect(onRequestClose).toHaveBeenCalledTimes(1);
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
