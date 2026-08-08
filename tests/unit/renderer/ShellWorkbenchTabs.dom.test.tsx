/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ShellWorkbenchTabs from '@/renderer/components/layout/Titlebar/ShellWorkbenchTabs';
import WorkbenchLayoutControls from '@/renderer/components/layout/Titlebar/WorkbenchLayoutControls';
import { PreviewProvider, usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { ELEMENTS_RAIL_REVEAL_EVENT, type ElementsRailRevealDetail } from '@/renderer/utils/workspace/workspaceEvents';

vi.mock('@/common', () => ({
  ipcBridge: {
    fileStream: { contentUpdate: { on: vi.fn(() => vi.fn()) } },
    preview: { open: { on: vi.fn(() => vi.fn()) } },
    fs: {
      writeFile: { invoke: vi.fn() },
      getFileMetadata: { invoke: vi.fn() },
      readFile: { invoke: vi.fn() },
      getImageBase64: { invoke: vi.fn() },
    },
  },
}));

vi.mock('@/renderer/utils/emitter', () => ({ emitter: { on: vi.fn(), off: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { title?: string }) => (options?.title ? `${key}:${options.title}` : key),
  }),
}));

let previewApi: ReturnType<typeof usePreviewContext> | null = null;

const CapturePreviewApi = () => {
  previewApi = usePreviewContext();
  return null;
};

const renderWorkbench = () =>
  render(
    <MemoryRouter initialEntries={['/conversation/conv-1']}>
      <PreviewProvider>
        <CapturePreviewApi />
        <ShellWorkbenchTabs conversationId='conv-1' />
      </PreviewProvider>
    </MemoryRouter>
  );

const renderLayoutControls = () =>
  render(
    <MemoryRouter initialEntries={['/conversation/conv-1']}>
      <PreviewProvider>
        <CapturePreviewApi />
        <WorkbenchLayoutControls />
      </PreviewProvider>
    </MemoryRouter>
  );

describe('ShellWorkbenchTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    previewApi = null;
    window.location.hash = '#/conversation/conv-1';
  });

  it('opens one real Browser tab and reuses it on subsequent launcher requests', () => {
    renderWorkbench();
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'conversation.workbench.browser' }));
    expect(previewApi?.tabs).toHaveLength(1);
    expect(previewApi?.tabs[0]).toMatchObject({
      content_type: 'url',
      content: 'about:blank',
      metadata: { title: 'Browser', conversation_id: 'conv-1' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'conversation.workbench.browser' }));
    expect(previewApi?.tabs).toHaveLength(1);
    expect(previewApi?.workbenchLayoutMode).toBe('sidecar');
    expect(previewApi?.isWorkbenchSidecarPinned).toBe(true);
  });

  it('switches between the four real workbench layouts and persists the choice', () => {
    renderLayoutControls();

    const splitRight = screen.getByRole('button', { name: 'conversation.workbench.splitRight' });
    fireEvent.click(splitRight);
    expect(previewApi?.workbenchLayoutMode).toBe('split-right');
    expect(splitRight).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('aionui_eve_workbench_layout_mode_v1')).toBe('split-right');

    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.splitBottom' }));
    expect(previewApi?.workbenchLayoutMode).toBe('split-bottom');

    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.focus' }));
    expect(previewApi?.workbenchLayoutMode).toBe('focus');

    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.sidecar' }));
    expect(previewApi?.workbenchLayoutMode).toBe('sidecar');
  });

  it('keeps unproven Terminal and Page chat actions visibly disabled', () => {
    renderWorkbench();
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    expect(screen.getByRole('menuitem', { name: /conversation\.workbench\.terminal/ })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /conversation\.workbench\.pageChat/ })).toBeDisabled();
  });

  it('reveals the existing files rail instead of inventing a second file browser', () => {
    const events: ElementsRailRevealDetail[] = [];
    const listener = (event: Event) => {
      events.push((event as CustomEvent<ElementsRailRevealDetail>).detail);
    };
    window.addEventListener(ELEMENTS_RAIL_REVEAL_EVENT, listener);
    renderWorkbench();
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'conversation.workbench.files' }));
    expect(events).toEqual([{ tab: 'context', workspaceTab: 'files' }]);
    window.removeEventListener(ELEMENTS_RAIL_REVEAL_EVENT, listener);
  });

  it('opens the real workspace changes surface for Review', () => {
    const railEvents: ElementsRailRevealDetail[] = [];
    const recordRail = (event: Event) => railEvents.push((event as CustomEvent<ElementsRailRevealDetail>).detail);
    window.addEventListener(ELEMENTS_RAIL_REVEAL_EVENT, recordRail);

    renderWorkbench();
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'conversation.workbench.review' }));

    expect(railEvents).toEqual([{ tab: 'context', workspaceTab: 'changes' }]);
    window.removeEventListener(ELEMENTS_RAIL_REVEAL_EVENT, recordRail);
  });

  it('switches back to Chat without deleting the active preview', () => {
    renderWorkbench();
    act(() => previewApi?.openPreview('# Notes', 'markdown', { title: 'notes.md', conversation_id: 'conv-1' }));
    expect(screen.getByRole('tab', { name: 'notes.md' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: 'conversation.workbench.chat' }));
    expect(previewApi?.isOpen).toBe(false);
    expect(previewApi?.tabs).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'conversation.workbench.chat' })).toHaveAttribute('aria-selected', 'true');
  });
});
