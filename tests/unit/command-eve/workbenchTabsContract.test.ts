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

    expect(titlebar).not.toContain('ShellWorkbenchTabs');
    expect(titlebar).not.toContain("'--eve-workbench-content-left'");
    expect(titlebarCss).not.toContain('.app-titlebar__brand--workbench');
    expect(chatLayout).toContain("<div className='eve-workbench-pane__tabbar'>");
    expect(chatLayout).toContain('<ShellWorkbenchTabs conversationId={conversation_id} />');
    expect(chatLayout).toContain('<ShellWorkbenchTabs conversationId={conversation_id} launcherOnly />');
    expect(chatLayout).toContain("'chat-layout-header--eve-launcher overflow-visible'");
    expect(chatLayoutCss).toContain('.chat-layout-header--eve-launcher');
    expect(chatLayoutCss).toContain('contain: none;');
    expect(chatLayout).toContain("ariaLabel: t('conversation.workbench.resizeSplit')");
    expect(chatLayout).toContain('aria-valuenow={Math.round(bottomPreviewRatio)}');
    expect(chatLayoutCss).toContain('.eve-workbench-pane__tabbar');
    expect(preview).toContain('!COMMAND_EVE_SHELL_ENABLED && (');
    expect(preview).toContain('<PreviewTabs');
  });

  it('preserves file identity tabs in EVE while retaining upstream browse replacement', () => {
    const fileOps = read('packages/desktop/src/renderer/pages/conversation/Workspace/hooks/useWorkspaceFileOps.ts');
    expect(fileOps).toContain('{ replace: !COMMAND_EVE_SHELL_ENABLED }');
  });

  it('keeps inspector destinations out of the add-work-surface launcher', () => {
    const workbench = read('packages/desktop/src/renderer/components/layout/Titlebar/ShellWorkbenchTabs.tsx');
    const elementsRail = read('packages/desktop/src/renderer/components/layout/Titlebar/ShellElementsRail.tsx');
    expect(workbench).toContain("type WorkbenchTarget = 'browser' | 'terminal'");
    expect(workbench).not.toContain('dispatchElementsRailRevealEvent');
    expect(elementsRail).toContain("{ key: 'artifacts'");
    expect(elementsRail).toContain("{ key: 'context'");
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

  it('keeps one canonical chat surface beside the selected work surface', () => {
    const context = read('packages/desktop/src/renderer/pages/conversation/Preview/context/PreviewContext.tsx');
    const workbench = read('packages/desktop/src/renderer/components/layout/Titlebar/ShellWorkbenchTabs.tsx');
    const layoutControls = read('packages/desktop/src/renderer/components/layout/Titlebar/WorkbenchLayoutControls.tsx');
    const chatLayout = read('packages/desktop/src/renderer/pages/conversation/components/ChatLayout/index.tsx');
    const chatLayoutCss = read(
      'packages/desktop/src/renderer/pages/conversation/components/ChatLayout/chat-layout.css'
    );
    const urlViewer = read('packages/desktop/src/renderer/pages/conversation/Preview/components/viewers/URLViewer.tsx');
    const webviewHost = read('packages/desktop/src/renderer/components/media/WebviewHost.tsx');

    expect(context).toContain("export type WorkbenchLayoutMode = 'focus' | 'split-right' | 'split-bottom'");
    expect(context).toContain("if (stored === 'sidecar') return 'split-right'");
    expect(workbench).toContain("setWorkbenchLayoutMode('split-right')");
    expect(workbench).not.toContain('conversation.workbench.chat');
    expect(workbench).not.toContain("target: 'page-chat'");
    expect(workbench).not.toContain("const orderedIds = ['chat'");
    expect(layoutControls).toContain("mode: 'split-right' as const");
    expect(layoutControls).toContain("mode: 'split-bottom' as const");
    expect(layoutControls).not.toContain("mode: 'sidecar' as const");
    expect(workbench).toContain('isOpen && visibleActiveTab && <WorkbenchLayoutControls />');
    expect(urlViewer).not.toContain('WorkbenchLayoutControls');
    expect(urlViewer).not.toContain('toolbarActions=');
    expect(webviewHost).toContain("{toolbarActions && <div className='aion-url-viewer-toolbar-actions'>");
    expect(webviewHost).toContain("aria-label={");
    expect(webviewHost).toContain("t('conversation.workbench.addressPlaceholder')");
    expect(chatLayout).toContain('data-eve-workbench-layout');
    expect(chatLayout.match(/\{props\.children\}/g)).toHaveLength(1);
    expect(chatLayout).toContain('{!layout?.isMobile && desktopHeader}');
    expect(chatLayout).not.toContain('eve-workbench-tab-chat-');
    expect(chatLayout).not.toContain('eve-chat-sidecar-header');
    expect(chatLayout).not.toContain('setWorkbenchSidecarPinned');
    expect(chatLayoutCss).not.toContain('.eve-chat-pane--sidecar-pinned');
    expect(chatLayoutCss).toContain('.eve-workbench-layout--split-bottom');
  });

  it('keeps workbench chrome and the inspector on one continuous canvas', () => {
    const layoutControlsCss = read(
      'packages/desktop/src/renderer/components/layout/Titlebar/WorkbenchLayoutControls.module.css'
    );
    const elementsRailCss = read(
      'packages/desktop/src/renderer/components/layout/Titlebar/ShellElementsRail.module.css'
    );

    expect(layoutControlsCss).not.toContain('box-shadow: inset 0 0 0 1px');
    expect(elementsRailCss).not.toMatch(/\.rail\s*\{[^}]*border-left:/s);
    expect(elementsRailCss).toMatch(/\.activityCard,\s*\n\.contextCard,\s*\n\.metaBlock\s*\{[^}]*border:\s*0;/s);
    expect(elementsRailCss).toMatch(/\.artifactButton,[\s\S]*?background:\s*transparent !important;/);
  });

  it('prevents an unrelated scheduled-task hover card from appearing after chat maximization', () => {
    const cronManager = read('packages/desktop/src/renderer/pages/cron/components/CronJobManager.tsx');
    expect(cronManager).toContain("trigger={COMMAND_EVE_SHELL_ENABLED ? 'click' : 'hover'}");
  });
});
