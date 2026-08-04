/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.820.3 — the BIND half of the staged-handle contract, as a pure parser.
 *
 * A managed image is staged in Main WITHOUT a conversation (generation happens
 * inside an agent turn Main cannot attribute). The conversation is granted at
 * the end of the turn: the finished ACP turn's `acp_tool_call` output carries
 * the path-free tool text, this parser lifts the staged handle (`img_h_…`) out
 * of it, and the renderer invokes `commandEve.imageArtifactBind` with the
 * handle and the tool call id — BEFORE the artifact refresh is emitted, so the
 * very first render already sees the bound record.
 *
 * The parser is pure and lives in `common/config` so the scan is unit-testable
 * without a renderer, and so the character-scan discipline of the rest of this
 * path applies: no regular expressions, no string-matching primitives the
 * semantic gate over the paid path has to argue about.
 *
 * PURE: no fs, no Electron, no IPC.
 */

import { isLowerHexOfLength } from './eveOpaqueTokenCore';
import { IMAGE_STAGED_HANDLE_PREFIX, isWellFormedImageStagedHandle } from './managedImageArtifactCore';

/**
 * The FIRST well-formed staged handle in a text, or `undefined`.
 *
 * A character scan rather than a regex, matching the rest of this path: find
 * each occurrence of the prefix, then judge the sixty-four characters after it
 * as lowercase hex. "First" is the honest answer to a text that names two — the
 * tool text this parses names exactly one, and a hand-edited text naming two is
 * ambiguous in a way no rule resolves better.
 */
export function extractImageStagedHandle(text: unknown): string | undefined {
  if (typeof text !== 'string' || text.length < IMAGE_STAGED_HANDLE_PREFIX.length + 64) return undefined;
  let from = 0;
  for (;;) {
    const at = text.indexOf(IMAGE_STAGED_HANDLE_PREFIX, from);
    if (at < 0) return undefined;
    const candidate = text.slice(at, at + IMAGE_STAGED_HANDLE_PREFIX.length + 64);
    if (isLowerHexOfLength(candidate.slice(IMAGE_STAGED_HANDLE_PREFIX.length), 64)) return candidate;
    // A prefix that is not followed by 64 hex chars is prose, not a handle —
    // keep scanning after it rather than mistaking it for one.
    from = at + IMAGE_STAGED_HANDLE_PREFIX.length;
  }
}

export type ImageArtifactBindCandidate = {
  toolCallId: string;
  handle: string;
};

/**
 * Lift a bind candidate out of one RAW `acp_tool_call` update payload.
 *
 * The update shape is the ACP wire (`tool_call_id` plus `content[]` items whose
 * `content.text` holds the tool's output). Anything that does not carry both a
 * tool call id and a well-formed staged handle yields `undefined` — the caller
 * collects candidates during the turn and binds them at `finish`, so a miss
 * here is simply "nothing to bind", never an error.
 */
export function collectImageBindFromToolCallUpdate(update: unknown): ImageArtifactBindCandidate | undefined {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return undefined;
  const record = update as Record<string, unknown>;
  const toolCallId = record.tool_call_id ?? record.toolCallId;
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return undefined;
  const content = record.content;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const inner = (item as Record<string, unknown>).content;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) continue;
    const handle = extractImageStagedHandle((inner as Record<string, unknown>).text);
    if (handle && isWellFormedImageStagedHandle(handle)) return { toolCallId, handle };
  }
  return undefined;
}
