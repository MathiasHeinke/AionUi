/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserWindow } from 'electron';
import { ipcBridge } from '@/common';
import { COMMAND_EVE_PROTOCOL_SCHEME, COMMAND_EVE_SHELL_ENABLED } from '@/common/config/commandEveShell';

export const PROTOCOL_SCHEME = COMMAND_EVE_SHELL_ENABLED ? COMMAND_EVE_PROTOCOL_SCHEME : 'aionui';

export type ParsedDeepLink = { action: string; params: Record<string, string> };

const MAX_DEEP_LINK_URL_LENGTH = 16 * 1024;
const MAX_DECODED_DATA_BYTES = 8 * 1024;
const MAX_PARAM_LENGTH: Record<string, number> = {
  base_url: 4096,
  api_key: 8192,
  key: 8192,
  name: 256,
  platform: 128,
  route: 256,
  v: 16,
};
const ALLOWED_ACTION_PARAMS: Record<string, ReadonlySet<string>> = {
  'add-provider': new Set(['base_url', 'api_key', 'key', 'name', 'platform', 'v']),
  'provider/add': new Set(['base_url', 'api_key', 'key', 'name', 'platform', 'v']),
  navigate: new Set(['route']),
};
const ALLOWED_NAVIGATE_ROUTE = /^\/(?:team|conversation)\/[A-Za-z0-9._~-]{1,160}$/;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isSafeDeepLinkParam(key: string, value: unknown, allowedKeys: ReadonlySet<string>): value is string {
  const maxLength = MAX_PARAM_LENGTH[key];
  return (
    allowedKeys.has(key) &&
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !hasControlCharacters(value)
  );
}

function decodeDataParam(value: string): Record<string, unknown> | null {
  if (value.length > MAX_DECODED_DATA_BYTES * 2) return null;
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.byteLength === 0 || decoded.byteLength > MAX_DECODED_DATA_BYTES) return null;
    const parsed = JSON.parse(decoded.toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Parse a product deep-link URL into action and params.
 * Supports two formats:
 *   1. command-eve://add-provider?base_url=xxx&api_key=xxx
 *   2. command-eve://provider/add?v=1&data=<base64 JSON>  (one-api / new-api style)
 */
export const parseDeepLinkUrl = (url: string): ParsedDeepLink | null => {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_DEEP_LINK_URL_LENGTH) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${PROTOCOL_SCHEME}:` || parsed.username || parsed.password) return null;

    const hostname = parsed.hostname || '';
    const pathname = parsed.pathname.replace(/^\/+/, '');
    const action = pathname ? `${hostname}/${pathname}` : hostname;
    const allowedKeys = ALLOWED_ACTION_PARAMS[action];
    if (!allowedKeys) return null;

    const entries = new Map<string, string>();
    parsed.searchParams.forEach((value, key) => {
      if (key !== 'data' && isSafeDeepLinkParam(key, value, allowedKeys)) entries.set(key, value);
    });

    const encodedData = parsed.searchParams.get('data');
    if (encodedData) {
      const data = decodeDataParam(encodedData);
      if (data) {
        for (const [key, value] of Object.entries(data)) {
          if (isSafeDeepLinkParam(key, value, allowedKeys)) entries.set(key, value);
        }
      }
    }

    const params = Object.fromEntries(entries);
    if (action === 'navigate' && !ALLOWED_NAVIGATE_ROUTE.test(params.route || '')) return null;
    return { action, params };
  } catch {
    return null;
  }
};

let mainWindowRef: BrowserWindow | null = null;
const initialDeepLinkUrl = process.argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
let pendingDeepLink: ParsedDeepLink | null = initialDeepLinkUrl ? parseDeepLinkUrl(initialDeepLinkUrl) : null;

export const setDeepLinkMainWindow = (win: BrowserWindow): void => {
  mainWindowRef = win;
};

export const takePendingDeepLink = (): ParsedDeepLink | null => {
  const pending = pendingDeepLink;
  pendingDeepLink = null;
  return pending;
};

export const deliverDeepLink = (payload: ParsedDeepLink): void => {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    pendingDeepLink = payload;
    return;
  }
  ipcBridge.deepLink.received.emit(payload);
};

/**
 * Send the deep-link payload to the renderer via IPC bridge.
 * If the window isn't ready yet, queue it.
 */
export const handleDeepLinkUrl = (url: string): void => {
  const parsed = parseDeepLinkUrl(url);
  if (!parsed) return;
  deliverDeepLink(parsed);
};
