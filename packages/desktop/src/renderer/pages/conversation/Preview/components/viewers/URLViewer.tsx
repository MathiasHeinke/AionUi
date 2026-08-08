/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { COMMAND_EVE_SHELL_ENABLED } from '@/common/config/commandEveShell';
import WorkbenchLayoutControls from '@/renderer/components/layout/Titlebar/WorkbenchLayoutControls';
import WebviewHost from '@/renderer/components/media/WebviewHost';

interface URLViewerProps {
  /** URL to display */
  url: string;
  /** Optional title for the page */
  title?: string;
  /** Stable workbench tab id for the Hermes preview reader. */
  tabId?: string;
}

/**
 * URL 预览组件 - 用于在应用内预览网页（对话框预览面板）
 * URL Preview component - for previewing web pages within the app (conversation preview panel)
 *
 * Delegates to the shared WebviewHost with navigation bar enabled.
 */
const URLViewer: React.FC<URLViewerProps> = ({ url, tabId }) => {
  return (
    <WebviewHost
      url={url}
      showNavBar
      className='bg-bg-1'
      toolbarActions={COMMAND_EVE_SHELL_ENABLED ? <WorkbenchLayoutControls /> : undefined}
      previewReaderId={tabId}
    />
  );
};

export default URLViewer;
