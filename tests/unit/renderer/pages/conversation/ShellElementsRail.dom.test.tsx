/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ELEMENTS_RAIL_SELECT_EVENT } from '@/renderer/utils/workspace/workspaceEvents';

const { openPreviewMock, previewState, runtimeState } = vi.hoisted(() => ({
  openPreviewMock: vi.fn(),
  previewState: {
    tabs: [] as Array<{
      id: string;
      title: string;
      content: string;
      content_type: 'markdown' | 'image';
      metadata?: { file_name?: string; conversation_id?: string };
    }>,
  },
  runtimeState: {
    isProcessing: false,
    view: { pendingConfirmations: 0 },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) => options?.name ?? key,
  }),
}));

vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => runtimeState,
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({
    tabs: previewState.tabs,
    openPreview: openPreviewMock,
  }),
}));

import ShellElementsRail from '@/renderer/components/layout/Titlebar/ShellElementsRail';

describe('ShellElementsRail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewState.tabs = [];
    runtimeState.isProcessing = false;
    runtimeState.view.pendingConfirmations = 0;
  });

  it('shows truthful ready state and an empty artifact state without invented work', () => {
    render(<ShellElementsRail conversationId='conv-1' conversationTitle='Neuer Chat' />);

    expect(screen.getByText('conversation.elementsRail.ready')).toBeTruthy();
    fireEvent.click(screen.getByTestId('elements-rail-tab-artifacts'));
    expect(screen.getByText('conversation.elementsRail.noArtifacts')).toBeTruthy();
  });

  it('opens a real artifact through Preview and closes the rail when requested', () => {
    const onRequestClose = vi.fn();
    previewState.tabs = [
      {
        id: 'artifact-1',
        title: 'Wettbewerbsanalyse.md',
        content: '# Analyse',
        content_type: 'markdown',
        metadata: { file_name: 'Wettbewerbsanalyse.md', conversation_id: 'conv-1' },
      },
      {
        id: 'artifact-other-chat',
        title: 'Fremder Chat.md',
        content: '# Other',
        content_type: 'markdown',
        metadata: { file_name: 'Fremder Chat.md', conversation_id: 'conv-2' },
      },
    ];

    render(<ShellElementsRail conversationId='conv-1' onRequestClose={onRequestClose} />);
    fireEvent.click(screen.getByTestId('elements-rail-tab-artifacts'));
    expect(screen.queryByText('Fremder Chat.md')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Wettbewerbsanalyse.md' }));

    expect(openPreviewMock).toHaveBeenCalledWith('# Analyse', 'markdown', {
      file_name: 'Wettbewerbsanalyse.md',
      conversation_id: 'conv-1',
    });
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
