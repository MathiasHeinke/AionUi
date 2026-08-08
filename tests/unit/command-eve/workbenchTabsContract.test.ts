import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Command EVE workbench tab contract', () => {
  it('has one app-level tab strip and removes the nested preview strip in EVE', () => {
    const titlebar = read('packages/desktop/src/renderer/components/layout/Titlebar/index.tsx');
    const titlebarCss = read('packages/desktop/src/renderer/components/layout/Titlebar/titlebar.css');
    const preview = read(
      'packages/desktop/src/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewPanel.tsx'
    );

    expect(titlebar).toContain('<ShellWorkbenchTabs conversationId={desktopConversationId} />');
    expect(titlebar).toContain("'--eve-workbench-content-left'");
    expect(titlebarCss).toContain('left: var(--eve-workbench-content-left, 324px);');
    expect(titlebarCss).toContain('right: 112px;');
    expect(preview).toContain('!COMMAND_EVE_SHELL_ENABLED && (');
    expect(preview).toContain('<PreviewTabs');
  });

  it('preserves file identity tabs in EVE while retaining upstream browse replacement', () => {
    const fileOps = read('packages/desktop/src/renderer/pages/conversation/Workspace/hooks/useWorkspaceFileOps.ts');
    expect(fileOps).toContain('{ replace: !COMMAND_EVE_SHELL_ENABLED }');
  });

  it('routes Review to the existing workspace changes surface', () => {
    const workbench = read('packages/desktop/src/renderer/components/layout/Titlebar/ShellWorkbenchTabs.tsx');
    const chatLayout = read('packages/desktop/src/renderer/pages/conversation/components/ChatLayout/index.tsx');
    const workspace = read('packages/desktop/src/renderer/pages/conversation/Workspace/index.tsx');
    expect(workbench).toContain("dispatchElementsRailRevealEvent('context', 'changes')");
    expect(workbench).toContain("dispatchElementsRailRevealEvent('context', 'files')");
    expect(chatLayout).toContain('pendingWorkspaceTabRef');
    expect(chatLayout).toContain('dispatchWorkspaceTabSelectEvent(pendingTab)');
    expect(workspace).toContain('WORKSPACE_TAB_SELECT_EVENT');
    expect(workspace).toContain('setActiveTab(tab);');
  });

  it('separates hiding a pane from destructive close-all behavior', () => {
    const context = read('packages/desktop/src/renderer/pages/conversation/Preview/context/PreviewContext.tsx');
    const conversationRoute = read('packages/desktop/src/renderer/pages/conversation/index.tsx');
    const previewPanel = read(
      'packages/desktop/src/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewPanel.tsx'
    );
    expect(context).toContain('const hidePreview = useCallback(() =>');
    expect(context).toContain('const requestCloseTab = useCallback(');
    expect(conversationRoute).toContain('const { hidePreview } = usePreviewContext();');
    expect(conversationRoute).toContain('hidePreview();');
    expect(conversationRoute).not.toContain('closePreview();');

    const hiddenRenderGuard = previewPanel.indexOf(
      'if (!activeTab || (!COMMAND_EVE_SHELL_ENABLED && !isOpen)) return null;'
    );
    const lastHook = previewPanel.lastIndexOf('useCallback(');
    expect(hiddenRenderGuard).toBeGreaterThan(lastHook);
    expect(previewPanel.slice(hiddenRenderGuard)).not.toMatch(/\buse(?:Effect|Memo|Callback|State|Ref)\s*\(/);
    expect(previewPanel).toContain('retain their live session');
    expect(previewPanel).toContain('const workbenchUrlTabs = useMemo(() =>');
    expect(previewPanel).toContain('workbenchUrlTabs.map((tab) =>');
    expect(previewPanel).toContain("style={{ display: isActive ? 'flex' : 'none' }}");
    expect(previewPanel).toContain('if (COMMAND_EVE_SHELL_ENABLED) return null;');
  });

  it('ships the founder-selected dominant-canvas layout with a pinnable EVE sidecar', () => {
    const context = read('packages/desktop/src/renderer/pages/conversation/Preview/context/PreviewContext.tsx');
    const workbench = read('packages/desktop/src/renderer/components/layout/Titlebar/ShellWorkbenchTabs.tsx');
    const layoutControls = read('packages/desktop/src/renderer/components/layout/Titlebar/WorkbenchLayoutControls.tsx');
    const chatLayout = read('packages/desktop/src/renderer/pages/conversation/components/ChatLayout/index.tsx');
    const chatLayoutCss = read(
      'packages/desktop/src/renderer/pages/conversation/components/ChatLayout/chat-layout.css'
    );
    const urlViewer = read('packages/desktop/src/renderer/pages/conversation/Preview/components/viewers/URLViewer.tsx');
    const webviewHost = read('packages/desktop/src/renderer/components/media/WebviewHost.tsx');

    expect(context).toContain("export type WorkbenchLayoutMode = 'focus' | 'split-right' | 'split-bottom' | 'sidecar'");
    expect(workbench).toContain("setWorkbenchLayoutMode('sidecar')");
    expect(layoutControls).toContain("mode: 'split-right' as const");
    expect(layoutControls).toContain("mode: 'split-bottom' as const");
    expect(urlViewer).toContain('toolbarActions={COMMAND_EVE_SHELL_ENABLED ? <WorkbenchLayoutControls /> : undefined}');
    expect(webviewHost).toContain("{toolbarActions && <div className='aion-url-viewer-toolbar-actions'>");
    expect(chatLayout).toContain('data-eve-workbench-layout');
    expect(chatLayout).toContain('eve-chat-pane--sidecar-pinned');
    expect(chatLayout).toContain('setWorkbenchSidecarPinned(!isWorkbenchSidecarPinned)');
    expect(chatLayout).toContain("onClick={() => setWorkbenchLayoutMode('focus')}");
    expect(chatLayoutCss).toContain('.eve-chat-pane--sidecar-pinned');
    expect(chatLayoutCss).toContain('.eve-workbench-layout--split-bottom');
  });

  it('prevents an unrelated scheduled-task hover card from appearing after chat maximization', () => {
    const cronManager = read('packages/desktop/src/renderer/pages/cron/components/CronJobManager.tsx');
    expect(cronManager).toContain("trigger={COMMAND_EVE_SHELL_ENABLED ? 'click' : 'hover'}");
  });
});
