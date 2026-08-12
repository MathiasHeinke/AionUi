/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { PreviewProvider, usePreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { ipcBridge } from '@/common';
import {
  canResolveWorkbenchArtifact,
  resetWorkbenchArtifactResolversForTest,
} from '@/renderer/pages/conversation/Preview/services/workbenchArtifactResolver';

const seatMock = vi.hoisted(() => ({ listeners: new Set<(seatId: string) => void>() }));

vi.mock('@/common/config/configService', () => ({
  configService: {
    onSeatRebind: (listener: (seatId: string) => void) => {
      seatMock.listeners.add(listener);
      return () => seatMock.listeners.delete(listener);
    },
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    fileStream: {
      contentUpdate: { on: vi.fn(() => vi.fn()) },
    },
    preview: {
      open: { on: vi.fn(() => vi.fn()) },
    },
    fs: {
      writeFile: { invoke: vi.fn() },
      getFileMetadata: { invoke: vi.fn() },
      readFile: { invoke: vi.fn() },
      getImageBase64: { invoke: vi.fn() },
    },
  },
}));

vi.mock('@/renderer/utils/emitter', () => ({
  emitter: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { language: 'en' },
  }),
}));

describe('PreviewContext', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <PreviewProvider>{children}</PreviewProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipcBridge.fs.getFileMetadata.invoke).mockResolvedValue(undefined);
    localStorage.clear();
    window.location.hash = '#/guid';
    seatMock.listeners.clear();
    resetWorkbenchArtifactResolversForTest();
  });

  afterEach(() => {
    cleanup();
    resetWorkbenchArtifactResolversForTest();
  });

  it('initializes with closed state', () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    expect(result.current.isOpen).toBe(false);
    expect(result.current.tabs).toEqual([]);
    expect(result.current.activeTabId).toBe(null);
  });

  it('opens preview and creates tab', () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => {
      result.current.openPreview('# Hello', 'markdown', { title: 'test.md' });
    });
    expect(result.current.isOpen).toBe(true);
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].content).toBe('# Hello');
    expect(result.current.tabs[0].content_type).toBe('markdown');
  });

  it('scopes chat previews to the conversation active when they are opened', () => {
    window.location.hash = '#/conversation/conv-1';
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => {
      result.current.openPreview('# Hello', 'markdown', { title: 'test.md' });
    });

    expect(result.current.tabs[0].metadata).toMatchObject({
      title: 'test.md',
      conversation_id: 'conv-1',
    });
  });

  it('does not reuse an identical preview across conversations', () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    window.location.hash = '#/conversation/conv-1';
    act(() => result.current.openPreview('# Same', 'markdown', { title: 'same.md' }));
    window.location.hash = '#/conversation/conv-2';
    act(() => result.current.openPreview('# Same', 'markdown', { title: 'same.md' }));

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.tabs.map((tab) => tab.metadata?.conversation_id)).toEqual(['conv-1', 'conv-2']);
  });

  it('closes preview and clears all tabs', () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => {
      result.current.openPreview('content', 'code');
    });
    act(() => {
      result.current.closePreview();
    });
    expect(result.current.isOpen).toBe(false);
    expect(result.current.tabs).toEqual([]);
  });

  it('provides all context API methods', () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    expect(typeof result.current.openPreview).toBe('function');
    expect(typeof result.current.showPreview).toBe('function');
    expect(typeof result.current.hidePreview).toBe('function');
    expect(typeof result.current.closePreview).toBe('function');
    expect(typeof result.current.requestCloseTab).toBe('function');
    expect(typeof result.current.setCloseTabRequestHandler).toBe('function');
    expect(typeof result.current.updateContent).toBe('function');
    expect(typeof result.current.findPreviewTab).toBe('function');
  });

  it('updates content and marks tab as dirty', () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => {
      result.current.openPreview('original', 'code');
    });
    expect(result.current.activeTab?.isDirty).toBe(false);
    act(() => {
      result.current.updateContent('modified');
    });
    expect(result.current.activeTab?.content).toBe('modified');
    expect(result.current.activeTab?.isDirty).toBe(true);
  });

  it('refuses save mutations for read-only artifact previews', async () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => {
      result.current.openPreview('# Trusted display', 'markdown', {
        title: 'artifact.md',
        file_path: '/workspace/artifact.md',
        workspace: '/workspace',
        editable: false,
      });
      result.current.updateContent('# Attempted mutation');
    });
    let saved = true;
    await act(async () => {
      saved = await result.current.saveContent();
    });
    expect(saved).toBe(false);
    expect(ipcBridge.fs.writeFile.invoke).not.toHaveBeenCalled();
  });

  it('hides and restores the preview without losing tabs or dirty buffers', () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => result.current.openPreview('original', 'code', { title: 'draft.ts' }));
    act(() => result.current.updateContent('edited'));
    const tabId = result.current.activeTabId;

    act(() => result.current.hidePreview());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0]).toMatchObject({ content: 'edited', isDirty: true });

    act(() => result.current.showPreview(tabId ?? undefined));
    expect(result.current.isOpen).toBe(true);
    expect(result.current.activeTabId).toBe(tabId);
    expect(result.current.activeTab).toMatchObject({ content: 'edited', isDirty: true });
  });

  it('closes a clean tab directly through the guarded close entrypoint', () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => result.current.openPreview('clean', 'code', { title: 'clean.ts' }));
    const tabId = result.current.activeTabId;

    act(() => result.current.requestCloseTab(tabId!));
    expect(result.current.tabs).toEqual([]);
    expect(result.current.isOpen).toBe(false);
  });

  it('removes typed UI tabs on a seat rebind and never persists them', async () => {
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => {
      result.current.openPreview('{"schema_version":"command-eve.typed-ui/v2"}', 'typed-ui', {
        conversation_id: 'conversation-1',
        artifact_id: 'tool-artifact-seat-a',
        artifact_kind: 'chat',
      });
    });
    expect(result.current.tabs).toHaveLength(1);

    act(() => {
      for (const listener of seatMock.listeners) listener('seat-b');
    });

    expect(result.current.tabs).toEqual([]);
    expect(result.current.isOpen).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(localStorage.getItem('aionui_preview_tabs') ?? '').not.toContain('typed-ui');
    expect(
      canResolveWorkbenchArtifact({
        kind: 'chat',
        conversationId: 'conversation-1',
        artifactId: 'tool-artifact-seat-a',
      })
    ).toBe(false);
  });

  it('does not restore a persisted typed UI tab into the new seat resolver', () => {
    localStorage.setItem(
      'aionui_preview_tabs',
      JSON.stringify([
        {
          id: 'typed-ui-seat-a',
          content: '{"schema_version":"command-eve.typed-ui/v2"}',
          content_type: 'typed-ui',
          title: 'Old typed UI',
          metadata: {
            conversation_id: 'conversation-1',
            artifact_id: 'tool-artifact-seat-a',
            artifact_kind: 'chat',
          },
        },
      ])
    );

    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    expect(result.current.tabs).toEqual([]);
    expect(
      canResolveWorkbenchArtifact({
        kind: 'chat',
        conversationId: 'conversation-1',
        artifactId: 'tool-artifact-seat-a',
      })
    ).toBe(false);
  });

  it('routes a dirty tab through the registered confirmation guard', () => {
    const guard = vi.fn();
    const { result } = renderHook(() => usePreviewContext(), { wrapper });
    act(() => result.current.openPreview('original', 'code', { title: 'dirty.ts' }));
    act(() => result.current.updateContent('edited'));
    const tabId = result.current.activeTabId;
    act(() => {
      result.current.setCloseTabRequestHandler(guard);
      result.current.hidePreview();
    });

    act(() => result.current.requestCloseTab(tabId!));
    expect(guard).toHaveBeenCalledWith(tabId);
    expect(result.current.isOpen).toBe(true);
    expect(result.current.activeTabId).toBe(tabId);
    expect(result.current.tabs).toHaveLength(1);
  });
});
