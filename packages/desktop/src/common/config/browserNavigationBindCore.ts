/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EVE's browser arm, made visible (B1, CEVE-1821).
 *
 * The URL-preview lane is fully built and has zero producers: `PreviewPanel`
 * renders `<URLViewer>` for `content_type === 'url'`, `URLViewer` delegates to a
 * real Electron `<webview>`, and `PreviewContext` already listens for
 * `preview.open` — but nothing in the renderer ever passes `'url'`. Meanwhile the
 * ACP lane really does carry the browser tools (`hermes-acp` in the bundled 0.20
 * wheel). EVE has been browsing where nobody could watch.
 *
 * WHERE THE URL ACTUALLY IS — measured, not assumed. In the wheel's ACP tool-call
 * builder, `browser_navigate` renders its title as
 *
 *     f"navigate: {args.get('url', '?')}"          (acp_adapter/tools.py:171-172)
 *
 * and that title is the second positional of `acp.start_tool_call`, so it lands
 * on the wire as `update.title`. The renderer already reads that exact field
 * (`useAcpMessage.ts:147`). The other candidates were checked and ruled out:
 * `raw_input` is passed only by the approval/permission builders and is `None`
 * for tool starts (`tools.py:1069`), and `extract_locations` (`tools.py:1338-1347`)
 * only ever emits a filesystem `path`, which `browser_navigate` does not have.
 * So the title is the ONLY carrier, and this parser reads nothing else.
 *
 * SCHEME IS A SECURITY BOUNDARY, NOT A NICETY. Whatever comes out of here is
 * handed to a real `<webview>`, so only `http:` and `https:` are accepted.
 * `file:` would turn a model's tool call into a local-file read inside our own
 * renderer; `javascript:` and `data:` are script execution with the same origin
 * as whatever loaded them. Those are refusals, not edge cases.
 *
 * Pure, total, and `undefined` on every miss — the same shape as
 * `collectImageBindFromToolCallUpdate`, and for the same reason: a parser that
 * runs on every tool update must never throw and must never guess.
 */

export interface BrowserNavigationCandidate {
  toolCallId: string;
  /** Always `http:` or `https:`, already normalised by the URL parser. */
  url: string;
  /** The raw title, kept for the panel heading. Never used for navigation. */
  title?: string;
}

/** The exact prefix the wheel builds (`tools.py:171-172`). */
const NAVIGATE_TITLE_PREFIX = 'navigate: ';

/** The literal the wheel emits when the model omitted `url` entirely. */
const MISSING_URL_PLACEHOLDER = '?';

/**
 * Accept ONLY web schemes. Everything else — including a URL that merely parses —
 * is refused, because the caller loads the result in a webview.
 */
export function isDisplayableBrowserUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Pull the navigation target out of ONE raw `acp_tool_call` update.
 *
 * Returns `undefined` for anything that is not a `browser_navigate` start with a
 * usable web URL: a different tool, a missing tool-call id, the wheel's `?`
 * placeholder, a non-web scheme, or a payload that is not the shape we measured.
 */
export function collectBrowserNavigationFromToolCallUpdate(update: unknown): BrowserNavigationCandidate | undefined {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return undefined;
  const record = update as Record<string, unknown>;

  const toolCallId = record.tool_call_id ?? record.toolCallId;
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return undefined;

  const title = record.title;
  if (typeof title !== 'string') return undefined;
  const trimmedTitle = title.trim();
  if (!trimmedTitle.startsWith(NAVIGATE_TITLE_PREFIX)) return undefined;

  const rawUrl = trimmedTitle.slice(NAVIGATE_TITLE_PREFIX.length).trim();
  // The wheel writes '?' when the model called browser_navigate without a url.
  // That is a tool call we cannot honour, not a page to show.
  if (rawUrl.length === 0 || rawUrl === MISSING_URL_PLACEHOLDER) return undefined;
  if (!isDisplayableBrowserUrl(rawUrl)) return undefined;

  return { toolCallId, url: new URL(rawUrl).toString(), title: trimmedTitle };
}

/**
 * Should the panel be (re-)opened for this URL?
 *
 * A page visit is one navigation followed by a stream of snapshots, clicks and
 * scrolls — all on the SAME url. Re-opening for each of those would yank the
 * panel out from under the user mid-read. A different url is a real navigation
 * and does re-open.
 */
export function shouldOpenBrowserPreview(url: string, lastOpenedUrl: string | undefined): boolean {
  if (!isDisplayableBrowserUrl(url)) return false;
  return url !== lastOpenedUrl;
}
