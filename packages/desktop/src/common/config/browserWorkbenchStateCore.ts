/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { detectCommandEveSensitiveEgress } from '@/common/api/egressBoundaryCore';

export const COMMAND_EVE_BROWSER_WORKBENCH_STATE_SCHEMA = 'command-eve-browser-workbench-state/v1' as const;
export const COMMAND_EVE_BROWSER_CONTEXT_SCHEMA = 'command-eve-browser-context/v1' as const;

const MAX_TABS = 24;
const MAX_HISTORY_ENTRIES = 64;
const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 180;
const TAB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SENSITIVE_QUERY_KEY_RE =
  /(?:password|passwd|passcode|otp|totp|2fa|mfa|recovery|secret|token|auth|credential|api[_-]?key|session|code)/i;

export interface CommandEveBrowserHistoryState {
  back: string[];
  forward: string[];
}

export interface CommandEveBrowserTabResume {
  id: string;
  title: string;
  url: string;
  conversation_id?: string;
  history: CommandEveBrowserHistoryState;
}

export interface CommandEveBrowserWorkbenchState {
  schema_version: typeof COMMAND_EVE_BROWSER_WORKBENCH_STATE_SCHEMA;
  active_tab_id: string | null;
  tabs: CommandEveBrowserTabResume[];
  updated_at: string;
}

export interface CommandEveBrowserContextDescriptor {
  schema_version: typeof COMMAND_EVE_BROWSER_CONTEXT_SCHEMA;
  context_id: string;
  partition: string;
  persistent: boolean;
  daemon_name: string;
  state: CommandEveBrowserWorkbenchState;
}

const hasSensitivePayload = (value: string): boolean =>
  detectCommandEveSensitiveEgress(value).some((finding) => ['secret', 'financial', 'health'].includes(finding.kind));

/**
 * Persist only resumable network URLs. Fragments never survive because OAuth
 * callbacks and recovery links commonly carry credentials there. Sensitive
 * query keys are removed individually; if the canonical S3 detector still
 * finds protected material, the entire query is discarded.
 */
export function sanitizeBrowserResumeUrl(value: unknown): string | null {
  if (value === 'about:blank') return 'about:blank';
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  for (const key of Array.from(parsed.searchParams.keys())) {
    if (SENSITIVE_QUERY_KEY_RE.test(key)) parsed.searchParams.delete(key);
  }
  if (hasSensitivePayload(parsed.toString())) parsed.search = '';

  const sanitized = parsed.toString();
  return sanitized.length <= MAX_URL_LENGTH ? sanitized : null;
}

export function sanitizeBrowserResumeTitle(value: unknown): string {
  if (typeof value !== 'string') return 'Browser';
  const compact = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
  if (!compact || hasSensitivePayload(compact)) return 'Browser';
  return compact;
}

const sanitizeHistoryList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const sanitized: string[] = [];
  for (const candidate of value) {
    const url = sanitizeBrowserResumeUrl(candidate);
    if (!url || sanitized[sanitized.length - 1] === url) continue;
    sanitized.push(url);
  }
  return sanitized.slice(-MAX_HISTORY_ENTRIES);
};

export function emptyBrowserWorkbenchState(now: () => Date = () => new Date()): CommandEveBrowserWorkbenchState {
  return {
    schema_version: COMMAND_EVE_BROWSER_WORKBENCH_STATE_SCHEMA,
    active_tab_id: null,
    tabs: [],
    updated_at: now().toISOString(),
  };
}

/** Normalize the renderer payload at the MAIN persistence boundary. */
export function normalizeBrowserWorkbenchState(
  value: unknown,
  now: () => Date = () => new Date()
): CommandEveBrowserWorkbenchState {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const inputTabs = Array.isArray(raw.tabs) ? raw.tabs : [];
  const tabs: CommandEveBrowserTabResume[] = [];

  for (const candidate of inputTabs.slice(0, MAX_TABS)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const tab = candidate as Record<string, unknown>;
    if (typeof tab.id !== 'string' || !TAB_ID_RE.test(tab.id)) continue;
    const url = sanitizeBrowserResumeUrl(tab.url);
    if (!url) continue;
    const history = tab.history && typeof tab.history === 'object' ? (tab.history as Record<string, unknown>) : {};
    const conversationId =
      typeof tab.conversation_id === 'string' && TAB_ID_RE.test(tab.conversation_id) ? tab.conversation_id : undefined;
    tabs.push({
      id: tab.id,
      title: sanitizeBrowserResumeTitle(tab.title),
      url,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      history: {
        back: sanitizeHistoryList(history.back),
        forward: sanitizeHistoryList(history.forward),
      },
    });
  }

  const activeTabId =
    typeof raw.active_tab_id === 'string' && tabs.some((tab) => tab.id === raw.active_tab_id)
      ? raw.active_tab_id
      : null;
  return {
    schema_version: COMMAND_EVE_BROWSER_WORKBENCH_STATE_SCHEMA,
    active_tab_id: activeTabId,
    tabs,
    updated_at: now().toISOString(),
  };
}
