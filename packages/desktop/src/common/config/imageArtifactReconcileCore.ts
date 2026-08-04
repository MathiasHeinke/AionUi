/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.820.3 — the DURABLE half of the staged-handle bind contract, as a pure
 * transcript extractor.
 *
 * The renderer's same-turn fast path collects staged handles from LIVE
 * `acp_tool_call` stream messages into a volatile map; R2 proved that a
 * managed image edit can complete, stage its child, and still never be bound
 * because that volatile path missed. This extractor reads the PERSISTED
 * transcript instead — the completed `acp_tool_call` rows the backend already
 * serves through the conversation messages API — so Main can reconcile binds
 * at turn end and at conversation load without trusting any live shape.
 *
 * STRICT by contract (CoS 1.820.3): only messages with `type: 'acp_tool_call'`
 * whose own status is finished/completed (when present), whose content parses
 * to an object carrying `update`, whose `update.status` is exactly
 * 'completed', whose `update.tool_call_id` is a non-empty string, and whose
 * content text carries a well-formed staged handle (`img_h_…`). Assistant
 * prose, thinking rows, tips, and every other message type are NEVER scanned
 * — a free-text mention of a handle-shaped string is not evidence of a
 * completed managed job.
 *
 * PURE: no fs, no Electron, no IPC, no regex (character-scan discipline of
 * the paid path, same as `imageArtifactBindCore`).
 */

import {
  collectImageBindFromToolCallUpdate,
  type ImageArtifactBindCandidate,
} from './imageArtifactBindCore';

const FINISHED_MESSAGE_STATUSES = new Set(['finish', 'finished', 'completed', 'complete', 'done']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Content arrives as a parsed object or as a JSON string; both are accepted,
 * anything else is not. A string that does not parse is not content. */
function parseMessageContent(content: unknown): Record<string, unknown> | undefined {
  if (isRecord(content)) return content;
  if (typeof content !== 'string' || content.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function messageIsCompleted(message: Record<string, unknown>): boolean {
  const status = message.status;
  // A message without a status field is tolerated (the backend's shape is not
  // ours to freeze); a status that IS present must read finished/completed.
  if (status === undefined || status === null) return true;
  return typeof status === 'string' && FINISHED_MESSAGE_STATUSES.has(status.trim().toLowerCase());
}

/**
 * The deduped bind candidates in one transcript window, in transcript order.
 * Dedupe is by tool call id — a completed row replayed by pagination or a
 * renderer/Main race binds ONCE (the store's idempotent bind does the rest).
 */
export function extractImageBindCandidatesFromTranscript(items: unknown): ImageArtifactBindCandidate[] {
  if (!Array.isArray(items)) return [];
  const byToolCallId = new Map<string, ImageArtifactBindCandidate>();
  for (const message of items) {
    if (!isRecord(message)) continue;
    if (message.type !== 'acp_tool_call') continue;
    if (!messageIsCompleted(message)) continue;
    const content = parseMessageContent(message.content);
    if (!content) continue;
    const update = content.update;
    if (!isRecord(update)) continue;
    // Only COMPLETED tool calls: an in-flight or failed call proves nothing
    // about a staged artifact, and a failed call must never bind one.
    if (update.status !== 'completed') continue;
    const candidate = collectImageBindFromToolCallUpdate(update);
    if (!candidate) continue;
    if (!byToolCallId.has(candidate.toolCallId)) byToolCallId.set(candidate.toolCallId, candidate);
  }
  return [...byToolCallId.values()];
}
