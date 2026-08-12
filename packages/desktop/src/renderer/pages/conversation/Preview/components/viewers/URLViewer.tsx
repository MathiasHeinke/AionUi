/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import WebviewHost from '@/renderer/components/media/WebviewHost';
import type { CommandEveBrowserHistoryState } from '@/common/config/browserWorkbenchStateCore';
import { COMMAND_EVE_SHELL_ENABLED } from '@/common/config/commandEveShell';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';

interface URLViewerProps {
  /** URL to display */
  url: string;
  /** Optional title for the page */
  title?: string;
  /** Stable workbench tab id for the Hermes preview reader. */
  tabId?: string;
  active?: boolean;
  initialHistory?: CommandEveBrowserHistoryState;
}

/**
 * URL 预览组件 - 用于在应用内预览网页（对话框预览面板）
 * URL Preview component - for previewing web pages within the app (conversation preview panel)
 *
 * Delegates to the shared WebviewHost with navigation bar enabled.
 */
const URLViewer: React.FC<URLViewerProps> = ({ url, tabId, active = true, initialHistory }) => {
  const { browserContext, updateBrowserNavigation } = usePreviewContext();
  if (COMMAND_EVE_SHELL_ENABLED && !browserContext) {
    return <div className='h-full w-full bg-bg-1' aria-busy='true' />;
  }
  return (
    <WebviewHost
      key={browserContext ? `${browserContext.context_id}:${browserContext.control_epoch}` : tabId}
      url={url}
      showNavBar
      className='bg-bg-1'
      previewReaderId={tabId}
      active={active}
      partition={COMMAND_EVE_SHELL_ENABLED ? browserContext?.partition : undefined}
      browserContextId={browserContext?.context_id}
      browserControlEpoch={browserContext?.control_epoch}
      initialHistory={initialHistory}
      onNavigationStateChange={
        tabId ? (nextUrl, history) => updateBrowserNavigation(tabId, nextUrl, history) : undefined
      }
    />
  );
};

export default URLViewer;
