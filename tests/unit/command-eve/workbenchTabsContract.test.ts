import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Command EVE workbench tab contract', () => {
  it('keeps the app titlebar global and mounts one local strip inside the work surface', () => {
    const titlebar = read('packages/desktop/src/renderer/components/layout/Titlebar/index.tsx');
    const titlebarCss = read('packages/desktop/src/renderer/components/layout/Titlebar/titlebar.css');
    const chatLayout = read('packages/desktop/src/renderer/pages/conversation/components/ChatLayout/index.tsx');
    const chatLayoutCss = read(
      'packages/desktop/src/renderer/pages/conversation/components/ChatLayout/chat-layout.css'
    );
    const preview = read(
      'packages/desktop/src/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewPanel.tsx'
    );
    const previewCss = read(
      'packages/desktop/src/renderer/pages/conversation/Preview/components/PreviewPanel/preview.css'
    );

    expect(titlebar).not.toContain('ShellWorkbenchTabs');
    expect(titlebar).not.toContain("'--eve-workbench-content-left'");
    expect(titlebarCss).not.toContain('.app-titlebar__brand--workbench');
    expect(chatLayout).toContain("<div className='eve-workbench-pane__tabbar'>");
    expect(chatLayout).toContain('conversationId={conversation_id}');
    expect(chatLayout).toContain('workspacePath={workspacePath}');
    expect(chatLayout).toContain('launcherOnly');
    expect(chatLayout).toContain("'chat-layout-header--eve-launcher overflow-visible'");
    expect(chatLayoutCss).toContain('.chat-layout-header--eve-launcher');
    expect(chatLayoutCss).toContain('contain: none;');
    expect(chatLayout).toContain("ariaLabel: t('conversation.workbench.resizeSplit')");
    expect(chatLayout).toContain('aria-valuenow={Math.round(bottomPreviewRatio)}');
    expect(chatLayoutCss).toContain('.eve-workbench-pane__tabbar');
    expect(preview).toContain('!COMMAND_EVE_SHELL_ENABLED && (');
    expect(preview).toContain('<PreviewTabs');
    expect(previewCss).toMatch(
      /\.eve-workbench-preview-surface\s*\{[^}]*flex:\s*1 1 auto;[^}]*width:\s*100%;[^}]*max-width:\s*100%;/s
    );
  });

  it('preserves file identity tabs in EVE while retaining upstream browse replacement', () => {
    const fileOps = read('packages/desktop/src/renderer/pages/conversation/Workspace/hooks/useWorkspaceFileOps.ts');
    expect(fileOps).toContain('{ replace: !COMMAND_EVE_SHELL_ENABLED }');
  });

  it('mounts Files and Review as native workbench surfaces without a second chat', () => {
    const workbench = read('packages/desktop/src/renderer/components/layout/Titlebar/ShellWorkbenchTabs.tsx');
    const previewTypes = read('packages/desktop/src/common/types/office/preview.ts');
    const previewPanel = read(
      'packages/desktop/src/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewPanel.tsx'
    );
    const chatLayout = read('packages/desktop/src/renderer/pages/conversation/components/ChatLayout/index.tsx');
    const chatConversation = read('packages/desktop/src/renderer/pages/conversation/components/ChatConversation.tsx');
    const workspace = read('packages/desktop/src/renderer/pages/conversation/Workspace/index.tsx');
    expect(workbench).toContain("type WorkbenchTarget = 'browser' | 'terminal' | 'kanban' | 'files' | 'review'");
    expect(workbench).toContain("openPreview(workspacePath ?? 'workspace:unavailable', 'workspace-files'");
    expect(workbench).toContain("openPreview(workspacePath ?? 'workspace:unavailable', 'workspace-review'");
    expect(previewPanel).toContain("t('conversation.workbench.notConnected')");
    expect(workbench).not.toContain('dispatchElementsRailRevealEvent');
    expect(previewTypes).toContain("| 'workspace-files'");
    expect(previewTypes).toContain("| 'workspace-review'");
    expect(previewPanel).toContain("fixedTab={content_type === 'workspace-review' ? 'changes' : 'files'}");
    expect(previewPanel).toContain('isTemporaryWorkspace={metadata?.is_temporary_workspace}');
    expect(workbench).toContain('is_temporary_workspace: isTemporaryWorkspace');
    expect(chatLayout).toContain("const workspaceEventPrefix = props.workspaceEventPrefix ?? 'acp';");
    expect(chatLayout).not.toContain("backend === 'codex' || backend === 'aionrs'");
    expect(chatConversation).toContain("conversation?.type === 'codex' ? 'codex'");
    expect(chatLayout).toContain('contextContent={isWorkspaceWorkbenchSurface ? undefined : props.sider}');
    expect(workspace).toContain('{!fixedTab && (');
  });

  it('reuses the native Hermes Kanban as a container-responsive workbench surface', () => {
    const workbench = read('packages/desktop/src/renderer/components/layout/Titlebar/ShellWorkbenchTabs.tsx');
    const previewTypes = read('packages/desktop/src/common/types/office/preview.ts');
    const previewPanel = read(
      'packages/desktop/src/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewPanel.tsx'
    );
    const kanban = read('packages/desktop/src/renderer/pages/kanban/index.tsx');

    expect(workbench).toContain("type WorkbenchTarget = 'browser' | 'terminal' | 'kanban' | 'files' | 'review'");
    expect(workbench).toContain("openPreview('kanban:default', 'kanban'");
    expect(workbench).toContain("t('kanban.title', { defaultValue: 'Aufgaben' })");
    expect(previewTypes).toContain("| 'kanban'");
    expect(previewPanel).toContain("const KanbanBoardHost = React.lazy(() => import('@/renderer/pages/kanban'))");
    expect(previewPanel).toContain('<KanbanBoardHost />');
    expect(previewPanel).toContain('!isKanbanSurface');
    expect(kanban).toContain('repeat(auto-fit, minmax(min(220px, 100%), 1fr))');
    expect(kanban).not.toContain('md:grid-cols-2 xl:grid-cols-5');
    expect(kanban).not.toContain('rounded-12px border border-dashed border-border-2');
  });

  it('routes generated documents and media into existing workbench viewers', () => {
    const rail = read('packages/desktop/src/renderer/components/layout/Titlebar/ShellElementsRail.tsx');
    const previewTypes = read('packages/desktop/src/common/types/office/preview.ts');
    const previewPanel = read(
      'packages/desktop/src/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewPanel.tsx'
    );

    expect(rail).toContain('artifactWorkbenchTypeOf');
    expect(rail).toContain("showPreview(urlSource, 'url')");
    expect(rail).toContain("contentType === 'pdf' || contentType === 'word'");
    expect(rail).toContain("contentType === 'video' || contentType === 'audio'");
    expect(previewTypes).toContain("| 'video'");
    expect(previewTypes).toContain("| 'audio'");
    expect(previewPanel).toContain("content_type === 'video' || content_type === 'audio'");
    expect(previewPanel).toContain('<MediaPreview');
  });

  it('uses the EVE theme contract for the terminal shell in light and dark mode', () => {
    const terminal = read(
      'packages/desktop/src/renderer/pages/conversation/Preview/components/viewers/TerminalViewer.tsx'
    );
    const terminalCss = read(
      'packages/desktop/src/renderer/pages/conversation/Preview/components/viewers/TerminalViewer.module.css'
    );
    const terminalTheme = read(
      'packages/desktop/src/renderer/pages/conversation/Preview/components/viewers/terminalTheme.ts'
    );

    expect(terminal).toContain('allowTransparency: true');
    expect(terminal).toContain('data-terminal-theme={currentTheme}');
    expect(terminalTheme).toContain('selectionInactiveBackground');
    expect(terminalTheme).toContain('brightWhite:');
    expect(terminalTheme).toContain('brightYellow:');
    expect(terminalTheme).toContain('background: transparent');
    expect(terminalCss).not.toContain('#0b0e14');
    expect(terminalCss).not.toContain('rgba(217, 225, 239');
    expect(terminalCss).toContain('var(--eve-shell-bg');
    expect(terminalCss).toContain('background-color: transparent !important;');
    expect(terminalCss).toMatch(/\.viewport :global\(\.xterm \.composition-view\)\s*\{[^}]*background:\s*color-mix/s);
    expect(terminalCss).toMatch(
      /\.viewport :global\(\.xterm \.composition-view\)\s*\{[^}]*color:\s*var\(--eve-shell-text/s
    );
    expect(terminalCss).toMatch(/\.viewport\s*\{[^}]*box-sizing:\s*border-box;/s);
    expect(terminalCss).toMatch(/\.viewport\s*\{[^}]*overflow:\s*hidden;/s);
    expect(terminalCss).toMatch(/\.viewport :global\(\.xterm\)\s*\{[^}]*width:\s*100%;/s);
    expect(terminalCss).not.toContain('border-bottom:');
    expect(terminalCss).toContain('var(--eve-status-completed');
    expect(terminalCss).toContain('var(--eve-status-error');
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
    expect(conversationRoute).toContain('keepPreviousData: true');
    expect(conversationRoute).toContain("visibility: 'hidden'");
    expect(conversationRoute).not.toContain('closePreview();');

    const hiddenRenderGuard = previewPanel.indexOf(
      'if (!activeTab || (!COMMAND_EVE_SHELL_ENABLED && !isOpen)) return null;'
    );
    const lastHook = previewPanel.lastIndexOf('useCallback(');
    expect(hiddenRenderGuard).toBeGreaterThan(lastHook);
    expect(previewPanel.slice(hiddenRenderGuard)).not.toMatch(/\buse(?:Effect|Memo|Callback|State|Ref)\s*\(/);
    expect(previewPanel).toContain('retain their live session');
    expect(previewPanel).toContain('const workbenchUrlTabs = useMemo(() =>');
    expect(previewPanel).toContain("return tabs.filter((tab) => tab.content_type === 'url');");
    expect(previewPanel).toContain("return tabs.filter((tab) => tab.content_type === 'terminal');");
    expect(previewPanel).not.toContain(
      "tab.content_type === 'terminal' && tab.metadata?.conversation_id === conversationId"
    );
    expect(previewPanel).toContain('workbenchUrlTabs.map((tab) =>');
    expect(previewPanel).toContain('const isVisible = isOpen && tab.id === activeTabId;');
    expect(previewPanel).toContain("style={{ display: isVisible ? 'flex' : 'none' }}");
    expect(previewPanel).toContain('active={isVisible}');
    expect(previewPanel).toContain('if (COMMAND_EVE_SHELL_ENABLED) return null;');
  });

  it('keeps one canonical chat surface beside the selected work surface', () => {
    const context = read('packages/desktop/src/renderer/pages/conversation/Preview/context/PreviewContext.tsx');
    const workbench = read('packages/desktop/src/renderer/components/layout/Titlebar/ShellWorkbenchTabs.tsx');
    const workbenchCss = read('packages/desktop/src/renderer/components/layout/Titlebar/ShellWorkbenchTabs.module.css');
    const layoutControls = read('packages/desktop/src/renderer/components/layout/Titlebar/WorkbenchLayoutControls.tsx');
    const chatLayout = read('packages/desktop/src/renderer/pages/conversation/components/ChatLayout/index.tsx');
    const chatLayoutCss = read(
      'packages/desktop/src/renderer/pages/conversation/components/ChatLayout/chat-layout.css'
    );
    const verticalSplit = read(
      'packages/desktop/src/renderer/pages/conversation/components/ChatLayout/verticalSplitDrag.ts'
    );
    const urlViewer = read('packages/desktop/src/renderer/pages/conversation/Preview/components/viewers/URLViewer.tsx');
    const webviewHost = read('packages/desktop/src/renderer/components/media/WebviewHost.tsx');

    expect(context).toContain(
      "export type WorkbenchLayoutMode = 'focus' | 'split-left' | 'split-right' | 'split-bottom'"
    );
    expect(context).toContain("if (stored === 'sidecar') return 'split-right'");
    expect(workbench).not.toContain("setWorkbenchLayoutMode('split-right')");
    expect(workbench).not.toContain('conversation.workbench.chat');
    expect(workbench).not.toContain("target: 'page-chat'");
    expect(workbench).not.toContain("const orderedIds = ['chat'");
    expect(layoutControls).toContain("mode: 'split-left' as const");
    expect(layoutControls).toContain("mode: 'split-right' as const");
    expect(layoutControls).toContain("mode: 'split-bottom' as const");
    expect(layoutControls).not.toContain("mode: 'sidecar' as const");
    expect(workbench).toContain('<WorkbenchLayoutControls effectiveMode={effectiveLayoutMode} />');
    expect(urlViewer).not.toContain('WorkbenchLayoutControls');
    expect(urlViewer).not.toContain('toolbarActions=');
    expect(webviewHost).toContain("{toolbarActions && <div className='aion-url-viewer-toolbar-actions'>");
    expect(webviewHost).toContain('aria-label={');
    expect(webviewHost).toContain("t('conversation.workbench.addressPlaceholder')");
    expect(webviewHost).toContain("className='toolbar-form'");
    expect(webviewHost).toContain('.aion-url-viewer-toolbar .toolbar-form');
    expect(webviewHost).toContain('align-self: stretch;');
    expect(webviewHost).toContain('max-width: none;');
    expect(webviewHost).toContain("style={{ display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 }}");
    expect(webviewHost).toContain(
      "style={{ display: 'flex', flex: '1 1 auto', width: 'auto', minWidth: 0, maxWidth: 'none' }}"
    );
    expect(webviewHost).toContain(
      "style={{ display: 'block', flex: '1 1 auto', width: '100%', minWidth: 0, maxWidth: 'none' }}"
    );
    expect(webviewHost).toContain("webview.addEventListener('did-attach', signalReady)");
    expect(webviewHost).toContain("webview.addEventListener('dom-ready', signalReady)");
    expect(webviewHost).toContain("webview.addEventListener('destroyed', signalLost)");
    expect(webviewHost).toContain("webview.addEventListener('render-process-gone', signalLost)");
    expect(webviewHost).toContain('announcer.dispose()');
    expect(webviewHost).toContain('}, [active, browserContextId, browserControlEpoch, previewReaderId]);');
    expect(workbench).toContain("data-testid='eve-workbench-dock-overlay'");
    expect(workbenchCss).toMatch(/\.dockOverlay\s*\{[^}]*pointer-events:\s*auto;/s);
    expect(workbench).toContain('onMouseDown={(event) => beginTabDock(event, tab.id)}');
    expect(workbench).not.toContain('onPointerDown={(event) => beginTabDock(event, tab.id)}');
    expect(workbench).not.toContain('application/x-command-eve-workbench-tab');
    expect(workbench).not.toContain('draggable=');
    expect(workbenchCss).toMatch(
      /\.root\[data-launcher-only='true'\]\s*\{[^}]*container-type:\s*normal;[^}]*flex:\s*0 0 32px;[^}]*width:\s*32px;/s
    );
    expect(workbench).toContain('<LeftBar');
    expect(workbench).toContain('<RightBar');
    expect(workbench).toContain('<BottomBar');
    expect(layoutControls).toContain('<LeftBar');
    expect(layoutControls).toContain('<RightBar');
    expect(layoutControls).toContain('<BottomBar');
    expect(chatLayout).toContain('data-eve-workbench-layout');
    expect(chatLayout.match(/\{props\.children\}/g)).toHaveLength(1);
    expect(chatLayout).toContain('{!layout?.isMobile && desktopHeader}');
    expect(chatLayout).not.toContain('eve-workbench-tab-chat-');
    expect(chatLayout).not.toContain('eve-chat-sidecar-header');
    expect(chatLayout).not.toContain('setWorkbenchSidecarPinned');
    expect(chatLayoutCss).not.toContain('.eve-chat-pane--sidecar-pinned');
    expect(chatLayoutCss).toContain('.eve-workbench-layout--split-bottom');
    expect(chatLayout).toContain('resolveAdaptiveWorkbenchLayout');
    expect(chatLayout).toContain('beginVerticalSplitDrag');
    expect(chatLayout).toContain('bottomDividerCleanupRef.current?.()');
    expect(verticalSplit).toContain("window.addEventListener('blur', finish)");
    expect(verticalSplit).toContain("dragHandle.addEventListener('lostpointercapture', finish)");
    expect(chatLayout).toContain('effectiveLayoutMode={activeWorkbenchLayout}');
    expect(chatLayout).toContain(": '260px'");
  });

  it('keeps workbench chrome and the inspector on one continuous canvas', () => {
    const workbenchCss = read('packages/desktop/src/renderer/components/layout/Titlebar/ShellWorkbenchTabs.module.css');
    const layoutControlsCss = read(
      'packages/desktop/src/renderer/components/layout/Titlebar/WorkbenchLayoutControls.module.css'
    );
    const elementsRailCss = read(
      'packages/desktop/src/renderer/components/layout/Titlebar/ShellElementsRail.module.css'
    );

    expect(layoutControlsCss).not.toMatch(/\.button\[data-active='true'\]\s*\{[^}]*--eve-focus-ring/);
    expect(elementsRailCss).not.toMatch(/\.rail\s*\{[^}]*border-left:/s);
    expect(elementsRailCss).toMatch(/\.activityCard,\s*\n\.contextCard,\s*\n\.metaBlock\s*\{[^}]*border:\s*0;/s);
    expect(elementsRailCss).toMatch(/\.artifactButton,[\s\S]*?background:\s*transparent !important;/);
    expect(workbenchCss).toContain('@container eve-workbench-tabs (max-width: 620px)');
    expect(workbenchCss).toContain(".tabShell:not([data-selected='true']) .tabLabel");
    expect(workbenchCss).toContain('.tabButton > :global(.i-icon)');
    expect(workbenchCss).not.toMatch(/\.tabShell\[data-selected='true'\][\s\S]*?inset 0 -2px/);
  });

  it('keeps the narrow chat useful and aligns sidebar labels on one text axis', () => {
    const layoutCalc = read('packages/desktop/src/renderer/pages/conversation/utils/layoutCalc.ts');
    const chatLayout = read('packages/desktop/src/renderer/pages/conversation/components/ChatLayout/index.tsx');
    const groupedHistory = read('packages/desktop/src/renderer/pages/conversation/GroupedHistory/index.tsx');
    const projectsEntry = read('packages/desktop/src/renderer/components/layout/Sider/SiderNav/SiderProjectsEntry.tsx');
    const workbench = read('packages/desktop/src/renderer/components/layout/Titlebar/ShellWorkbenchTabs.tsx');

    expect(layoutCalc).toContain('export const MIN_CHAT_PANEL_PX = 340;');
    expect(layoutCalc).toContain('const shouldConstrainChatPreview = workspaceEnabled && isDesktop && isPreviewOpen;');
    expect(layoutCalc).toContain(
      'export const MIN_HORIZONTAL_WORKBENCH_PX = MIN_CHAT_PANEL_PX + MIN_PREVIEW_PANEL_PX;'
    );
    expect(layoutCalc).toContain('export const resolveAdaptiveWorkbenchLayout =');
    expect(chatLayout).toContain('`${MIN_CHAT_PANEL_PX}px`');
    expect(groupedHistory).toContain('pl-10px pr-8px gap-8px');
    expect(groupedHistory).toContain('size-22px flex items-center justify-center text-t-tertiary shrink-0');
    expect(projectsEntry).toContain('size-22px flex items-center justify-center shrink-0 line-height-0');
    expect(projectsEntry).toContain("type='text'");
    expect(projectsEntry).toContain('!rd-8px');
    expect(workbench).toContain('<Earth');
    expect(workbench).toContain('<ListCheckbox');
    expect(workbench).not.toContain('<Browser');
    expect(workbench).not.toContain('<ViewGridCard');
  });

  it('prevents an unrelated scheduled-task hover card from appearing after chat maximization', () => {
    const cronManager = read('packages/desktop/src/renderer/pages/cron/components/CronJobManager.tsx');
    expect(cronManager).toContain("trigger={COMMAND_EVE_SHELL_ENABLED ? 'click' : 'hover'}");
  });
});
