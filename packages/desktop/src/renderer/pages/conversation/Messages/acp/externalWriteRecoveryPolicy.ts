/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Maximum report body accepted by the renderer recovery classifier (UTF-8 bytes). */
export const ACP_EXTERNAL_WRITE_RECOVERY_MAX_MARKDOWN_BYTES = 1024 * 1024;

const MAX_TOOL_CALL_ID_CHARS = 256;
const MAX_REQUESTED_PATH_CHARS = 4096;
const MAX_RESULT_TEXT_CHARS = 16 * 1024;

export type AcpExternalWriteBlock = {
  toolCallId: string;
  requestedPath: string;
  /** A path-free basename hint. Main sanitizes it again before creating a file. */
  suggestedName: string;
  markdown: string;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : undefined;
}

function parseRawInput(value: unknown): UnknownRecord | undefined {
  const direct = asRecord(value);
  if (direct) return direct;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > ACP_EXTERNAL_WRITE_RECOVERY_MAX_MARKDOWN_BYTES * 2
  ) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function boundedString(record: UnknownRecord, keys: readonly string[], maxChars: number): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0 && trimmed.length <= maxChars && !trimmed.includes('\0')) return value;
  }
  return undefined;
}

function isExternalRequestedPath(value: string): boolean {
  const requested = value.trim();
  if (requested.length === 0 || requested.length > MAX_REQUESTED_PATH_CHARS || requested.includes('\0')) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(requested)) return false;
  return (
    requested.startsWith('/') ||
    requested.startsWith('~/') ||
    requested.startsWith('~\\') ||
    /^[A-Za-z]:[\\/]/.test(requested) ||
    requested.startsWith('\\\\')
  );
}

function portableBasename(value: string): string | undefined {
  const normalized = value.trim().replace(/[\\/]+$/, '');
  if (!normalized) return undefined;
  const name = normalized.split(/[\\/]/).at(-1)?.trim();
  if (!name || name === '.' || name === '..' || name.includes('\0')) return undefined;
  return name.slice(0, 255);
}

function hasHardBlockedResultMarker(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  for (const item of content) {
    const itemRecord = asRecord(item);
    if (itemRecord?.type !== 'content') continue;
    const inner = asRecord(itemRecord?.content);
    if (inner?.type !== 'text') continue;
    const text = inner?.text;
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_RESULT_TEXT_CHARS) continue;
    if (/^\s*RESULT:\s*HardBlocked\s*$/.test(text)) return true;
  }
  return false;
}

function hasBoundedMarkdown(markdown: string): boolean {
  if (markdown.trim().length === 0) return false;
  return new TextEncoder().encode(markdown).byteLength <= ACP_EXTERNAL_WRITE_RECOVERY_MAX_MARKDOWN_BYTES;
}

/**
 * Classify the one ACP failure that the desktop may recover locally.
 *
 * Fail-closed by construction: only a failed write/edit tool update, carrying an
 * exact typed text result marker (`RESULT: HardBlocked`), an
 * external requested target and a bounded markdown body qualifies. Report prose,
 * shell/read failures, malformed inputs and relative workspace writes do not.
 */
export function classifyAcpExternalWriteBlock(payload: unknown): AcpExternalWriteBlock | undefined {
  const envelope = asRecord(payload);
  const update = asRecord(envelope?.update ?? payload);
  if (!update || update.status !== 'failed') return undefined;
  const sessionUpdate = update.sessionUpdate ?? update.session_update;
  if (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update') return undefined;

  const operation = typeof update.kind === 'string' ? update.kind.toLowerCase() : '';
  if (operation !== 'write' && operation !== 'edit') return undefined;

  const toolCallIdValue = update.tool_call_id ?? update.toolCallId;
  if (
    typeof toolCallIdValue !== 'string' ||
    toolCallIdValue.trim().length === 0 ||
    toolCallIdValue.length > MAX_TOOL_CALL_ID_CHARS ||
    toolCallIdValue.includes('\0')
  ) {
    return undefined;
  }

  // The marker is accepted only from the tool RESULT channel. A report body
  // containing the words "RESULT: HardBlocked" is data, never authority.
  if (!hasHardBlockedResultMarker(update.content)) return undefined;

  const rawInput = parseRawInput(update.rawInput) ?? parseRawInput(update.raw_input);
  if (!rawInput) return undefined;
  const requestedPath = boundedString(
    rawInput,
    ['path', 'file_path', 'filePath', 'target_path', 'targetPath'],
    MAX_REQUESTED_PATH_CHARS
  );
  if (!requestedPath || !isExternalRequestedPath(requestedPath)) return undefined;

  const markdown = boundedString(
    rawInput,
    ['markdown', 'content', 'text', 'new_text', 'newText', 'data'],
    ACP_EXTERNAL_WRITE_RECOVERY_MAX_MARKDOWN_BYTES
  );
  if (!markdown || !hasBoundedMarkdown(markdown)) return undefined;

  const suggestedName = portableBasename(requestedPath);
  if (!suggestedName) return undefined;

  return {
    toolCallId: toolCallIdValue.trim(),
    requestedPath: requestedPath.trim(),
    suggestedName,
    markdown,
  };
}
