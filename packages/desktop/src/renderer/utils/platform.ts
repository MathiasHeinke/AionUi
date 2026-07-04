/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Platform detection utilities
 * 平台检测工具函数
 */

import { getBaseUrl } from '@/common/adapter/httpBridge';

/**
 * Check if running in Electron desktop environment
 * 检测是否运行在 Electron 桌面环境
 */
export const isElectronDesktop = (): boolean => {
  return typeof window !== 'undefined' && Boolean(window.electronAPI);
};

/**
 * Check if running on macOS
 * 检测是否运行在 macOS
 */
export const isMacOS = (): boolean => {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent);
};

/**
 * Check if running on Windows
 * 检测是否运行在 Windows
 */
export const isWindows = (): boolean => {
  return typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent);
};

/**
 * Check if running on Linux
 * 检测是否运行在 Linux
 */
export const isLinux = (): boolean => {
  return typeof navigator !== 'undefined' && /linux/i.test(navigator.userAgent);
};

function isAbsoluteAssetUrl(url: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//');
}

/**
 * Resolve a backend-served asset URL for the current environment.
 * In Electron, renderer pages are file:// based, so backend-relative paths
 * must be expanded against the backend HTTP origin.
 */
export const resolveBackendAssetUrl = (url: string | undefined): string | undefined => {
  if (!url) return url;
  if (isAbsoluteAssetUrl(url) || /^data:/i.test(url)) return url;
  if (url.startsWith('/')) {
    return isElectronDesktop() ? `${getBaseUrl()}${url}` : url;
  }
  return url;
};

/**
 * Resolve Vite public-directory assets for the current renderer origin.
 *
 * These files are copied next to `index.html` in packaged Electron builds.
 * Absolute `/asset.ext` URLs resolve to the filesystem root under `file://`,
 * so they must become document-relative there. Backend assets still use
 * `resolveBackendAssetUrl`.
 */
export const resolvePublicAssetUrl = (url: string | undefined): string | undefined => {
  if (!url) return url;
  if (isAbsoluteAssetUrl(url) || /^data:/i.test(url)) return url;
  if (url.startsWith('/')) {
    return isElectronDesktop() ? url.slice(1) : url;
  }
  return url;
};

/**
 * Resolve an extension asset URL for the current environment.
 * Backend-managed extension assets are already emitted as HTTP URLs, so this
 * helper resolves app-relative backend paths into absolute backend URLs when
 * the desktop renderer is not same-origin with the backend process.
 *
 * 将扩展资源 URL 转换为当前环境可用的地址
 */
export const resolveExtensionAssetUrl = (url: string | undefined): string | undefined => {
  return resolveBackendAssetUrl(url);
};

/**
 * Open external URL in the appropriate context
 * - Electron: uses shell.openExternal via IPC (opens on local machine)
 * - WebUI: uses window.open in client browser (opens on remote client)
 *
 * 在适当的环境中打开外部链接
 * - Electron: 通过 IPC 调用 shell.openExternal（在本地机器打开）
 * - WebUI: 使用 window.open 在客户端浏览器打开（在远程客户端打开）
 */
export const openExternalUrl = async (url: string): Promise<void> => {
  if (!url) return;

  if (isElectronDesktop()) {
    const { ipcBridge } = await import('@/common');
    await ipcBridge.shell.openExternal.invoke(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};

// The pinned command-eve.com account origin (single source for the web fallback).
const COMMAND_EVE_WEB_ORIGIN = 'https://command-eve.com';

/**
 * APP→WEB AUTH HANDOFF (money-critical). Open a command-eve.com account path
 * (`/account?intent=add_seat`, `/account?pack_eur=<n>`, …) in the system browser
 * WITH the desktop session carried across, so the user lands LOGGED IN and the
 * checkout can start. This replaces the old `openExternalUrl('https://command-eve.com/account…')`
 * pattern, which opened the browser with its own empty localStorage session → the
 * user arrived logged out and the purchase never began.
 *
 * In Electron the token is attached IN MAIN (via the `command-eve.open-account-web`
 * provider — the renderer never sees the token). In the plain web build there is no
 * MAIN process and no desktop session, so we fall back to a normal external open of
 * the absolute URL (unchanged behaviour). Never throws — the buy path must not
 * hard-fail; a failure degrades to a naked external open.
 *
 * @param path an ABSOLUTE app path beginning with '/', e.g. '/account?intent=add_seat'.
 */
export const openAccountWeb = async (path: string): Promise<void> => {
  const safePath = typeof path === 'string' && path.startsWith('/') ? path : '/account';

  if (isElectronDesktop()) {
    try {
      const { ipcBridge } = await import('@/common');
      const res = (await ipcBridge.commandEve.openAccountWeb.invoke({ path: safePath })) as
        | { success?: boolean; data?: { ok?: boolean } }
        | undefined;
      // M-browser-open-masked (Codex): the MAIN handoff now reports success:false when
      // it could open NEITHER the token URL nor the naked fallback. Only return early
      // on a genuine success — otherwise fall through to this renderer's own
      // openExternalUrl (a distinct shell.openExternal IPC), so a browser genuinely
      // gets a second attempt instead of the buy path silently believing it opened.
      if (res?.success !== false && res?.data?.ok !== false) return;
    } catch {
      // MAIN handoff unavailable → fall through to a naked external open (logged out).
    }
  }
  await openExternalUrl(`${COMMAND_EVE_WEB_ORIGIN}${safePath}`);
};
