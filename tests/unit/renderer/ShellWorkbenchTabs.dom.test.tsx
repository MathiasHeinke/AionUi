/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ShellWorkbenchTabs from '@/renderer/components/layout/Titlebar/ShellWorkbenchTabs';
import WorkbenchLayoutControls from '@/renderer/components/layout/Titlebar/WorkbenchLayoutControls';
import { LayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { PreviewProvider, usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { emitter } from '@/renderer/utils/emitter';

vi.mock('@/common', () => ({
  ipcBridge: {
    application: { browserContextChanged: { on: vi.fn(() => vi.fn()) } },
    conversation: { realtimeConnected: { on: vi.fn(() => vi.fn()) } },
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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { title?: string }) => (options?.title ? `${key}:${options.title}` : key),
  }),
}));

let previewApi: ReturnType<typeof usePreviewContext> | null = null;
const setSiderCollapsedMock = vi.fn();

const CapturePreviewApi = () => {
  previewApi = usePreviewContext();
  return null;
};

const renderWorkbench = (
  props: Partial<React.ComponentProps<typeof ShellWorkbenchTabs>> = {},
  container?: HTMLElement
) =>
  render(
    <MemoryRouter initialEntries={['/conversation/conv-1']}>
      <LayoutContext.Provider
        value={{ isMobile: false, siderCollapsed: false, setSiderCollapsed: setSiderCollapsedMock }}
      >
        <PreviewProvider>
          <CapturePreviewApi />
          <ShellWorkbenchTabs conversationId='conv-1' workspacePath='/tmp/eve-project' {...props} />
        </PreviewProvider>
      </LayoutContext.Provider>
    </MemoryRouter>,
    container ? { container } : undefined
  );

const renderLauncher = () =>
  render(
    <MemoryRouter initialEntries={['/conversation/conv-1']}>
      <PreviewProvider>
        <CapturePreviewApi />
        <ShellWorkbenchTabs conversationId='conv-1' workspacePath='/tmp/eve-project' launcherOnly />
      </PreviewProvider>
    </MemoryRouter>
  );

const renderLayoutControls = (effectiveMode?: React.ComponentProps<typeof WorkbenchLayoutControls>['effectiveMode']) =>
  render(
    <MemoryRouter initialEntries={['/conversation/conv-1']}>
      <PreviewProvider>
        <CapturePreviewApi />
        <WorkbenchLayoutControls effectiveMode={effectiveMode} />
      </PreviewProvider>
    </MemoryRouter>
  );

describe('ShellWorkbenchTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    previewApi = null;
    setSiderCollapsedMock.mockReset();
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

  it('hosts one conversation-bound durable worker detail as a normal workbench tab', () => {
    renderWorkbench();

    act(() => {
      previewApi?.openPreview('worker-1', 'durable-work', {
        title: 'Inspect worker activity',
        conversation_id: 'conv-1',
      });
    });

    expect(previewApi?.tabs).toHaveLength(1);
    expect(previewApi?.tabs[0]).toMatchObject({
      content: 'worker-1',
      content_type: 'durable-work',
      metadata: { title: 'Inspect worker activity', conversation_id: 'conv-1' },
    });
    expect(screen.getByRole('tab', { name: 'Inspect worker activity' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('keeps a newly opened current-conversation worker detail visible after a stale tab was hidden', async () => {
    let nextFrameId = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const flushFrames = () => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(performance.now()));
    };

    try {
      renderWorkbench();
      act(() => {
        previewApi?.openPreview('old-worker', 'durable-work', {
          title: 'Old worker',
          conversation_id: 'conv-2',
        });
      });
      await waitFor(() => expect(previewApi?.activeTab?.metadata?.conversation_id).toBe('conv-2'));
      act(flushFrames);
      expect(previewApi?.isOpen).toBe(false);

      act(() => {
        previewApi?.openPreview('current-worker', 'durable-work', {
          title: 'Current worker',
          conversation_id: 'conv-1',
        });
      });
      await waitFor(() => expect(previewApi?.activeTab?.metadata?.conversation_id).toBe('conv-1'));
      act(flushFrames);

      expect(previewApi?.isOpen).toBe(true);
      expect(screen.getByRole('tab', { name: 'Current worker' })).toHaveAttribute('aria-selected', 'true');
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it('switches between the four real workbench layouts and persists the choice', () => {
    renderLayoutControls();

    const splitLeft = screen.getByRole('button', { name: 'conversation.workbench.splitLeft' });
    fireEvent.click(splitLeft);
    expect(previewApi?.workbenchLayoutMode).toBe('split-left');
    expect(splitLeft).toHaveAttribute('aria-pressed', 'true');

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

  it('preserves the chosen left or bottom layout when the user switches tools', () => {
    renderWorkbench();
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'conversation.workbench.browser' }));

    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.splitLeft' }));
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'conversation.workbench.terminal' }));
    expect(previewApi?.workbenchLayoutMode).toBe('split-left');

    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.splitBottom' }));
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'kanban.title' }));
    expect(previewApi?.workbenchLayoutMode).toBe('split-bottom');
  });

  it('shows a transient narrow-width bottom fallback without overwriting the preferred side', () => {
    localStorage.setItem('aionui_eve_workbench_layout_mode_v1', 'split-left');
    renderLayoutControls('split-bottom');

    expect(previewApi?.workbenchLayoutMode).toBe('split-left');
    expect(localStorage.getItem('aionui_eve_workbench_layout_mode_v1')).toBe('split-left');
    expect(screen.getByRole('button', { name: 'conversation.workbench.splitLeft' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    expect(screen.getByRole('button', { name: 'conversation.workbench.splitBottom' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('docks a mouse-dragged existing tab through the visible left/right/bottom targets', () => {
    const layout = document.createElement('div');
    layout.dataset.eveWorkbenchLayout = 'split-right';
    layout.getBoundingClientRect = () =>
      ({ top: 40, left: 100, width: 900, height: 640, right: 1000, bottom: 680, x: 100, y: 40 }) as DOMRect;
    document.body.append(layout);
    renderWorkbench({}, layout);
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'conversation.workbench.browser' }));

    const points = {
      'split-left': { clientX: 280, clientY: 220 },
      'split-right': { clientX: 820, clientY: 220 },
      'split-bottom': { clientX: 550, clientY: 560 },
    } as const;

    for (const target of ['split-left', 'split-right', 'split-bottom'] as const) {
      const tab = screen.getByRole('tab', { name: 'Browser' });
      fireEvent.mouseDown(tab, {
        button: 0,
        clientX: 520,
        clientY: 62,
      });
      fireEvent.mouseMove(window, {
        buttons: 1,
        ...points[target],
      });
      expect(screen.getByTestId('eve-workbench-dock-overlay')).toBeInTheDocument();
      expect(screen.getByTestId(`eve-workbench-dock-${target}`)).toHaveAttribute('data-active', 'true');
      fireEvent.mouseUp(window, {
        button: 0,
        ...points[target],
      });
      expect(previewApi?.workbenchLayoutMode).toBe(target);
      expect(screen.queryByTestId('eve-workbench-dock-overlay')).not.toBeInTheDocument();
    }
    layout.remove();
  });

  it('keeps clicks and out-of-bounds pointer releases from changing the chosen layout', () => {
    const layout = document.createElement('div');
    layout.dataset.eveWorkbenchLayout = 'split-right';
    layout.getBoundingClientRect = () =>
      ({ top: 40, left: 100, width: 900, height: 640, right: 1000, bottom: 680, x: 100, y: 40 }) as DOMRect;
    document.body.append(layout);
    renderWorkbench({}, layout);
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'conversation.workbench.browser' }));
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.splitBottom' }));

    const tab = screen.getByRole('tab', { name: 'Browser' });
    fireEvent.mouseDown(tab, {
      button: 0,
      clientX: 520,
      clientY: 62,
    });
    fireEvent.mouseMove(window, {
      buttons: 1,
      clientX: 523,
      clientY: 65,
    });
    expect(screen.queryByTestId('eve-workbench-dock-overlay')).not.toBeInTheDocument();
    fireEvent.mouseUp(window, {
      button: 0,
      clientX: 523,
      clientY: 65,
    });
    expect(previewApi?.workbenchLayoutMode).toBe('split-bottom');

    fireEvent.mouseDown(tab, {
      button: 0,
      clientX: 520,
      clientY: 62,
    });
    fireEvent.mouseMove(window, {
      buttons: 1,
      clientX: 40,
      clientY: 20,
    });
    expect(screen.getByTestId('eve-workbench-dock-overlay')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^eve-workbench-dock-split-/).every((zone) => zone.dataset.active === 'false')).toBe(
      true
    );
    fireEvent.mouseUp(window, {
      button: 0,
      clientX: 40,
      clientY: 20,
    });
    expect(previewApi?.workbenchLayoutMode).toBe('split-bottom');
    expect(screen.queryByTestId('eve-workbench-dock-overlay')).not.toBeInTheDocument();
    layout.remove();
  });

  it('cleans body drag styles on blur and unmount', () => {
    const layout = document.createElement('div');
    layout.dataset.eveWorkbenchLayout = 'split-right';
    layout.getBoundingClientRect = () =>
      ({ top: 40, left: 100, width: 900, height: 640, right: 1000, bottom: 680, x: 100, y: 40 }) as DOMRect;
    document.body.append(layout);
    const rendered = renderWorkbench({}, layout);
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'conversation.workbench.browser' }));
    const tab = screen.getByRole('tab', { name: 'Browser' });

    fireEvent.mouseDown(tab, {
      button: 0,
      clientX: 520,
      clientY: 62,
    });
    fireEvent.mouseMove(window, {
      buttons: 1,
      clientX: 280,
      clientY: 220,
    });
    expect(document.body.style.cursor).toBe('grabbing');
    expect(document.body.style.userSelect).toBe('none');
    fireEvent.blur(window);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');

    fireEvent.mouseDown(tab, {
      button: 0,
      clientX: 520,
      clientY: 62,
    });
    fireEvent.mouseMove(window, {
      buttons: 1,
      clientX: 820,
      clientY: 220,
    });
    rendered.unmount();
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    layout.remove();
  });

  it('returns to the canonical Chat without closing or recreating work surfaces', () => {
    renderWorkbench();
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'conversation.workbench.browser' }));
    const tabId = previewApi?.activeTabId;

    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.returnToChat' }));

    expect(previewApi?.isOpen).toBe(false);
    expect(previewApi?.tabs).toHaveLength(1);
    expect(previewApi?.activeTabId).toBe(tabId);
  });

  it('migrates the retired sidecar preference to the general split layout', () => {
    localStorage.setItem('aionui_eve_workbench_layout_mode_v1', 'sidecar');
    renderLayoutControls();
    expect(previewApi?.workbenchLayoutMode).toBe('split-right');
  });

  it('opens one real conversation-scoped Terminal and never offers a second Page chat', () => {
    renderWorkbench();
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'conversation.workbench.terminal' }));
    expect(previewApi?.tabs).toHaveLength(1);
    expect(previewApi?.tabs[0]).toMatchObject({
      content_type: 'terminal',
      content: 'terminal:conv-1',
      metadata: {
        title: 'conversation.workbench.terminal',
        conversation_id: 'conv-1',
        workspace: '/tmp/eve-project',
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'conversation.workbench.terminal' }));
    expect(previewApi?.tabs).toHaveLength(1);
    expect(screen.queryByRole('menuitem', { name: /conversation\.workbench\.pageChat/ })).not.toBeInTheDocument();
  });

  it('opens one native Hermes Kanban tab and reuses it', () => {
    renderWorkbench();
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'kanban.title' }));

    expect(previewApi?.tabs).toHaveLength(1);
    expect(previewApi?.tabs[0]).toMatchObject({
      content_type: 'kanban',
      content: 'kanban:default',
      metadata: { title: 'kanban.title', conversation_id: 'conv-1' },
    });
    expect(screen.getByRole('tab', { name: 'kanban.title' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'kanban.title' }));
    expect(previewApi?.tabs).toHaveLength(1);
    expect(previewApi?.workbenchLayoutMode).toBe('split-right');
  });

  it('opens Files and Review as real conversation-scoped workbench surfaces', async () => {
    const previewPane = document.createElement('div');
    previewPane.id = 'eve-workbench-pane-conv-1';
    previewPane.tabIndex = -1;
    document.body.append(previewPane);
    renderWorkbench({ isTemporaryWorkspace: true });
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    expect(screen.getByRole('menuitem', { name: 'conversation.workbench.browser' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: 'conversation.workbench.terminal' })).toBeEnabled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'conversation.workbench.files' }));
    expect(previewApi?.tabs).toHaveLength(1);
    expect(previewApi?.tabs[0]).toMatchObject({
      content_type: 'workspace-files',
      content: '/tmp/eve-project',
      metadata: {
        title: 'conversation.workbench.files',
        conversation_id: 'conv-1',
        workspace: '/tmp/eve-project',
        workspace_event_prefix: 'acp',
        is_temporary_workspace: true,
      },
    });
    await waitFor(() => expect(previewPane).toHaveFocus());

    fireEvent.click(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'conversation.workbench.review' }));
    expect(previewApi?.tabs).toHaveLength(2);
    expect(previewApi?.tabs[1]).toMatchObject({
      content_type: 'workspace-review',
      content: '/tmp/eve-project',
      metadata: {
        title: 'conversation.workbench.review',
        conversation_id: 'conv-1',
        workspace: '/tmp/eve-project',
        workspace_event_prefix: 'acp',
        is_temporary_workspace: true,
      },
    });
    expect(screen.getByRole('tab', { name: 'conversation.workbench.review' })).toHaveAttribute('aria-selected', 'true');
    previewPane.remove();
  });

  it('routes native Hermes pane focus into the canonical workbench, Chat, and session list', async () => {
    const previewPane = document.createElement('div');
    previewPane.id = 'eve-workbench-pane-conv-1';
    previewPane.tabIndex = -1;
    const sessionsPane = document.createElement('div');
    sessionsPane.dataset.commandEvePane = 'sessions';
    sessionsPane.tabIndex = -1;
    const chatPane = document.createElement('div');
    chatPane.id = 'eve-chat-pane-conv-1';
    chatPane.tabIndex = -1;
    document.body.append(previewPane, sessionsPane, chatPane);
    renderWorkbench();

    act(() => emitter.emit('commandEve.workbench.reveal', { conversation_id: 'conv-1', pane: 'terminal' }));
    expect(previewApi?.tabs).toHaveLength(1);
    expect(previewApi?.tabs[0]?.content_type).toBe('terminal');

    act(() => emitter.emit('commandEve.workbench.reveal', { conversation_id: 'conv-1', pane: 'files' }));
    act(() => emitter.emit('commandEve.workbench.reveal', { conversation_id: 'conv-1', pane: 'review' }));
    expect(previewApi?.tabs.map((tab) => tab.content_type)).toEqual([
      'terminal',
      'workspace-files',
      'workspace-review',
    ]);

    act(() => emitter.emit('commandEve.workbench.reveal', { conversation_id: 'foreign', pane: 'terminal' }));
    expect(previewApi?.tabs).toHaveLength(3);

    act(() => emitter.emit('commandEve.workbench.reveal', { conversation_id: 'conv-1', pane: 'chat' }));
    expect(previewApi?.isOpen).toBe(false);
    await waitFor(() => expect(chatPane).toHaveFocus());

    act(() => emitter.emit('commandEve.workbench.reveal', { conversation_id: 'conv-1', pane: 'sessions' }));
    expect(setSiderCollapsedMock).toHaveBeenCalledWith(false);
    await waitFor(() => expect(sessionsPane).toHaveFocus());

    previewPane.remove();
    sessionsPane.remove();
    chatPane.remove();
  });

  it('renders launcher-only mode without a duplicate tab strip or layout controls', () => {
    renderLauncher();
    act(() => previewApi?.openPreview('# Notes', 'markdown', { title: 'notes.md', conversation_id: 'conv-1' }));
    expect(screen.queryByRole('tablist', { name: 'conversation.workbench.label' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'conversation.workbench.layoutLabel' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'conversation.workbench.openLauncher' })).toBeInTheDocument();
  });

  it('lets the launcher-only header create the first Hermes-requested workbench tab', () => {
    renderLauncher();

    act(() => emitter.emit('commandEve.workbench.reveal', { conversation_id: 'conv-1', pane: 'terminal' }));

    expect(previewApi?.tabs).toHaveLength(1);
    expect(previewApi?.tabs[0]).toMatchObject({
      content_type: 'terminal',
      metadata: { conversation_id: 'conv-1' },
    });
    expect(previewApi?.isOpen).toBe(true);
  });

  it('reveals an honest Files surface when Hermes asks before a workspace exists', () => {
    renderWorkbench({ workspacePath: undefined });

    act(() => emitter.emit('commandEve.workbench.reveal', { conversation_id: 'conv-1', pane: 'files' }));

    expect(previewApi?.tabs).toHaveLength(1);
    expect(previewApi?.tabs[0]).toMatchObject({
      content: 'workspace:unavailable',
      content_type: 'workspace-files',
      metadata: { conversation_id: 'conv-1' },
    });
    expect(previewApi?.tabs[0]?.metadata).not.toHaveProperty('workspace');
    expect(previewApi?.isOpen).toBe(true);
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
    expect(screen.getByRole('tab', { name: 'answer.ts' })).toHaveAttribute('title', 'answer.ts');

    fireEvent.keyDown(document, { key: 'Tab', ctrlKey: true });

    expect(screen.getByRole('tab', { name: 'notes.md' })).toHaveAttribute('aria-selected', 'true');
    expect(previewApi?.isOpen).toBe(true);
    expect(previewApi?.tabs).toHaveLength(2);
  });
});
