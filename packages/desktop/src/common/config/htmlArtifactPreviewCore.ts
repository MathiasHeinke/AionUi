/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * B7 — EVE writes an HTML file, and the user sees it (CEVE-1821).
 *
 * Same shape as B1: the display layer is finished and had no producer.
 * `PreviewPanel` renders the split-screen HTML editor + renderer for
 * `content_type === 'html'` (PreviewPanel.tsx:275, :531-620), `fileType.ts:21-22`
 * already maps `.html`/`.htm` onto it, and `usePreviewLauncher.launchPreview`
 * already reads a file off disk and opens the tab. Nothing ever asked it to.
 *
 * WHY THIS BINDS ON COMPLETION, AND WHY THAT NEEDED TWO STEPS.
 *
 * A written file is a finished artifact, unlike B1's navigation which is live
 * state: at `start_tool_call` the file is not on disk yet and the approval is
 * still pending, so previewing then shows a file that does not exist. So the
 * bind belongs on the completion.
 *
 * But the completion update DOES NOT CARRY THE PATH — measured, not assumed.
 * `build_tool_complete` (acp_adapter/tools.py:1305-1329) calls
 * `acp.update_tool_call(tool_call_id, kind=…, status=…, content=…,
 * raw_output=…)`: no `locations`, no `title`. And `raw_output` is `None` because
 * `write_file` is in `_POLISHED_TOOLS` (tools.py:66, :1328). The path appears in
 * the completion CONTENT only sometimes — `_format_edit_result` (tools.py:693-713)
 * includes it for a dict result but returns the raw truncated string for a plain
 * one, so it is not a carrier anyone may depend on.
 *
 * The START update does carry it, twice: `title` = `write: <path>`
 * (tools.py:103-104) and `locations[0].path` (tools.py:1338-1347, and unlike
 * `browser_navigate` a `write_file` genuinely has a `path`). So the path is
 * REMEMBERED from the start, keyed by tool-call id, and SPENT when that id
 * completes. Same two-phase shape the image bind already uses.
 *
 * THE EXTENSION TABLE IS NOT COPIED HERE. `fileType.ts` owns the mapping and
 * stays the only place that does; this module takes a resolver and accepts a path
 * only when that resolver answers `'html'`. That also keeps the parser honest to
 * its own contract: no fs, no Electron, no IPC, and no second table to drift.
 */

export interface HtmlWriteCandidate {
  toolCallId: string;
  path: string;
}

/** The prefix the wheel builds for a write_file title (acp_adapter/tools.py:103-104). */
const WRITE_TITLE_PREFIX = 'write: ';

function readToolCallId(record: Record<string, unknown>): string | undefined {
  const raw = record.tool_call_id ?? record.toolCallId;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * The path a `write_file` START update names, or undefined.
 *
 * `locations[0].path` first: it is the structured carrier and needs no prefix
 * parsing. The `write: ` title is the fallback for the shape where the builder
 * emitted no locations — a fallback, not a preference, because a title is prose
 * and prose changes.
 */
export function extractWriteTargetPath(update: unknown): string | undefined {
  const record = asRecord(update);
  if (!record) return undefined;

  const locations = record.locations;
  if (Array.isArray(locations)) {
    for (const entry of locations) {
      const location = asRecord(entry);
      const candidate = location?.path;
      if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
    }
  }

  const title = record.title;
  if (typeof title === 'string') {
    const trimmed = title.trim();
    if (trimmed.startsWith(WRITE_TITLE_PREFIX)) {
      const fromTitle = trimmed.slice(WRITE_TITLE_PREFIX.length).trim();
      if (fromTitle.length > 0 && fromTitle !== '?') return fromTitle;
    }
  }
  return undefined;
}

/**
 * PHASE ONE — remember an HTML write from the START update.
 *
 * `resolveContentType` is injected rather than imported so the extension table
 * lives in exactly one place (`fileType.ts`). Anything it does not call `'html'`
 * is not our business here: markdown already has its own lane.
 */
export function collectHtmlWriteFromToolCallStart(
  update: unknown,
  resolveContentType: (fileName: string) => string | undefined
): HtmlWriteCandidate | undefined {
  const record = asRecord(update);
  if (!record) return undefined;
  const toolCallId = readToolCallId(record);
  if (!toolCallId) return undefined;
  const path = extractWriteTargetPath(update);
  if (!path) return undefined;
  let contentType: string | undefined;
  try {
    contentType = resolveContentType(path);
  } catch {
    return undefined;
  }
  return contentType === 'html' ? { toolCallId, path } : undefined;
}

/**
 * PHASE TWO — did THIS tool call finish?
 *
 * `completed` only. A `failed` write left nothing worth showing, and opening a
 * panel on it would claim an artifact that does not exist — the same falsehood
 * this whole slice exists to remove.
 */
export function isCompletedToolCallUpdate(update: unknown): string | undefined {
  const record = asRecord(update);
  if (!record) return undefined;
  const toolCallId = readToolCallId(record);
  if (!toolCallId) return undefined;
  return record.status === 'completed' ? toolCallId : undefined;
}

/**
 * Should the panel open for this path?
 *
 * Rewriting the same file — which an agent iterating on one page does constantly —
 * must not re-open the tab under the user. A different file is a different
 * artifact and does open.
 */
export function shouldOpenHtmlPreview(path: string, lastOpenedPath: string | undefined): boolean {
  if (typeof path !== 'string' || path.trim().length === 0) return false;
  return path !== lastOpenedPath;
}
