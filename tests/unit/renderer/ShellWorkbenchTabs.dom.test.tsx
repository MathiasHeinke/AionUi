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

const renderLauncher = () =>
  render(
    <MemoryRouter initialEntries={['/conversation/conv-1']}>
      <PreviewProvider>
        <CapturePreviewApi />
        <ShellWorkbenchTabs conversationId='conv-1' launcherOnly />
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
    expect(screen.getByRole('group', { name: 'conversation.workbench.layoutLabel' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'conversation.workbench.browser' }));
    expect(previewApi?.tabs).toHaveLength(1);
    expect(previewApi?.workbenchLayoutMode).toBe('split-right');
  });

  it('switches between the three real workbench layouts and persists the choice', () => {
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
    expect(screen.queryByRole('button', { name: 'conversation.workbench.sidecar' })).not.toBeInTheDocument();
  });

  it('migrates the retired sidecar preference to the general split layout', () => {
    localStorage.setItem('aionui_eve_workbench_layout_mode_v1', 'sidecar');
    renderLayoutControls();
    expect(previewApi?.workbenchLayoutMode).toBe('split-right');
  });

  it('keeps unproven Terminal disabled and never offers a second Page chat', () => {
    renderWorkbench();
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    expect(screen.getByRole('menuitem', { name: /conversation\.workbench\.terminal/ })).toBeDisabled();
    expect(screen.queryByRole('menuitem', { name: /conversation\.workbench\.pageChat/ })).not.toBeInTheDocument();
  });

  it('keeps Files and Review in the inspector instead of pretending they are new work surfaces', () => {
    renderLauncher();
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    expect(screen.queryByRole('menuitem', { name: 'conversation.workbench.files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'conversation.workbench.review' })).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'conversation.workbench.browser' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: /conversation\.workbench\.terminal/ })).toBeDisabled();
  });

  it('renders launcher-only mode without a duplicate tab strip or layout controls', () => {
    renderLauncher();
    act(() => previewApi?.openPreview('# Notes', 'markdown', { title: 'notes.md', conversation_id: 'conv-1' }));
    expect(screen.queryByRole('tablist', { name: 'conversation.workbench.label' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'conversation.workbench.layoutLabel' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' })).toBeInTheDocument();
  });

  it('does not register work-surface keyboard shortcuts from launcher-only mode', () => {
    renderLauncher();
    act(() => previewApi?.openPreview('# Notes', 'markdown', { title: 'notes.md', conversation_id: 'conv-1' }));
    act(() => previewApi?.openPreview('const answer = 42;', 'code', { title: 'answer.ts', conversation_id: 'conv-1' }));
    expect(previewApi?.activeTabId).toBe(previewApi?.tabs[1]?.id);

    fireEvent.keyDown(document, { key: 'Tab', ctrlKey: true });

    expect(previewApi?.activeTabId).toBe(previewApi?.tabs[1]?.id);
  });

  it('keeps the canonical Chat out of the work-surface tab strip', () => {
    renderWorkbench();
    act(() => previewApi?.openPreview('# Notes', 'markdown', { title: 'notes.md', conversation_id: 'conv-1' }));
    expect(screen.getByRole('tab', { name: 'notes.md' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'conversation.workbench.chat' })).not.toBeInTheDocument();
    expect(previewApi?.isOpen).toBe(true);
    expect(previewApi?.tabs).toHaveLength(1);
  });

  it('cycles only real work surfaces without hiding the canonical Chat', () => {
    renderWorkbench();
    act(() => previewApi?.openPreview('# Notes', 'markdown', { title: 'notes.md', conversation_id: 'conv-1' }));
    act(() => previewApi?.openPreview('const answer = 42;', 'code', { title: 'answer.ts', conversation_id: 'conv-1' }));
    expect(screen.getByRole('tab', { name: 'answer.ts' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(document, { key: 'Tab', ctrlKey: true });

    expect(screen.getByRole('tab', { name: 'notes.md' })).toHaveAttribute('aria-selected', 'true');
    expect(previewApi?.isOpen).toBe(true);
    expect(previewApi?.tabs).toHaveLength(2);
  });
});
