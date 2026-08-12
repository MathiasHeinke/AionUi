/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Type definitions for message tool results
 * 消息工具结果类型定义
 */

import type { IGeneratedArtifactType, IGeneratedConversationArtifact } from '@/common/adapter/ipcBridge';
import type { IMessageToolGroup } from '@/common/chat/chatLib';

export interface ImageGenerationResult {
  img_url?: string;
  relative_path?: string;
  error?: string;
}

export interface WriteFileResult {
  file_diff: string;
  file_name: string;
  [key: string]: unknown;
}

type ToolResultItem = IMessageToolGroup['content'][number];
type ToolResultDisplay = ToolResultItem['result_display'];

const GENERATED_ARTIFACT_TYPES: IGeneratedArtifactType[] = ['image', 'video', 'audio', 'html', 'file'];
const URL_KEYS = [
  'url',
  'file_url',
  'fileUrl',
  'href',
  'src',
  'data_url',
  'download_url',
  'output_url',
  'preview_url',
  'thumbnail_url',
  'img_url',
  'image_url',
  'video_url',
  'audio_url',
];
const PATH_KEYS = ['path', 'file_path', 'filePath', 'absolute_path', 'absolutePath'];
const RELATIVE_PATH_KEYS = ['relative_path', 'relativePath'];
const ARTIFACT_ID_KEYS = ['artifact_id', 'artifactId'];
const REQUEST_ID_KEYS = ['request_id', 'requestId'];
const RECEIPT_KEYS = ['receipt', 'safety_receipt', 'data_boundary_receipt', 'egress_receipt'];
const RECEIPT_PATH_KEYS = ['receipt_path', 'receiptPath'];
const SOURCE_KEYS = [...URL_KEYS, ...PATH_KEYS, ...RELATIVE_PATH_KEYS, ...ARTIFACT_ID_KEYS, ...REQUEST_ID_KEYS];
const SUCCESSFUL_ARTIFACT_RECEIPT_STATUSES = new Set([
  'success',
  'succeeded',
  'done',
  'completed',
  'verified',
  'pass',
  'passed',
  'local-only-pass',
]);
const SECRET_OR_RAW_RECEIPT_KEY =
  /^(?:authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|data[_-]?base64|base64|prompt|text|content|html|src|url|.*[_-]url|.*uri)$/i;
const SECRET_OR_RAW_RECEIPT_VALUE =
  /^(?:data:)|\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{6,}|sk-or-v1-[A-Za-z0-9._-]+|sk-[A-Za-z0-9._-]+|xai-[A-Za-z0-9._-]{16,})\b/i;

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readString(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readNumber(payload: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readRecord(payload: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return undefined;
}

function normalizeArtifactType(value?: string): IGeneratedArtifactType | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  return GENERATED_ARTIFACT_TYPES.includes(normalized as IGeneratedArtifactType)
    ? (normalized as IGeneratedArtifactType)
    : undefined;
}

function inferTypeFromMimeOrSource(payload: Record<string, unknown>): IGeneratedArtifactType | undefined {
  const mimeType = readString(payload, ['mime_type', 'media_type', 'mimeType', 'mediaType'])?.toLowerCase();
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('video/')) return 'video';
  if (mimeType?.startsWith('audio/')) return 'audio';
  if (mimeType?.includes('html')) return 'html';

  const source = readString(payload, [...URL_KEYS, ...PATH_KEYS, ...RELATIVE_PATH_KEYS]);
  const extension = source?.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
  if (extension && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp'].includes(extension)) return 'image';
  if (extension && ['mp4', 'mov', 'webm', 'm4v'].includes(extension)) return 'video';
  if (extension && ['mp3', 'wav', 'm4a', 'ogg', 'aac'].includes(extension)) return 'audio';
  if (extension && ['html', 'htm'].includes(extension)) return 'html';
  return undefined;
}

function inferGeneratedArtifactType(payload: Record<string, unknown>): IGeneratedArtifactType | undefined {
  const explicitType = normalizeArtifactType(readString(payload, ['artifact_type', 'type', 'kind']));
  if (explicitType) return explicitType;
  if (readString(payload, ['img_url', 'image_url'])) return 'image';
  if (readString(payload, ['video_url'])) return 'video';
  if (readString(payload, ['audio_url'])) return 'audio';
  return inferTypeFromMimeOrSource(payload);
}

function hasArtifactErrorOrUnverifiedReceipt(payload: Record<string, unknown>): boolean {
  if (Object.prototype.hasOwnProperty.call(payload, 'error')) return true;
  if (
    payload.ok === false ||
    payload.success === false ||
    payload.failed === true ||
    payload.blocked === true ||
    Object.prototype.hasOwnProperty.call(payload, 'failure')
  ) {
    return true;
  }

  // A producer may put its terminal result marker directly on the payload
  // rather than under a receipt. An outer tool-group Success must not override
  // a failed, blocked, pending, unverified, or malformed inner status.
  if (Object.prototype.hasOwnProperty.call(payload, 'status')) {
    const status = readString(payload, ['status'])?.toLowerCase();
    if (!status || !SUCCESSFUL_ARTIFACT_RECEIPT_STATUSES.has(status)) return true;
  }

  // A result may carry more than one receipt type. Every present receipt must
  // affirm the terminal result; accepting the first one would let a completed
  // receipt conceal a blocked or unverified companion receipt.
  for (const key of RECEIPT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue;
    const receipt = payload[key];
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return true;
    const status = readString(receipt as Record<string, unknown>, ['status'])?.toLowerCase();
    if (!status || !SUCCESSFUL_ARTIFACT_RECEIPT_STATUSES.has(status)) return true;
  }

  return false;
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function sanitizeReceiptValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || SECRET_OR_RAW_RECEIPT_VALUE.test(trimmed)) return undefined;
    return trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
  }
  if (depth >= 3) return undefined;
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 20)
      .map((item) => sanitizeReceiptValue(item, depth + 1))
      .filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 32)) {
      if (SECRET_OR_RAW_RECEIPT_KEY.test(key)) continue;
      const sanitized = sanitizeReceiptValue(nested, depth + 1);
      if (sanitized !== undefined) result[key] = sanitized;
    }
    return Object.keys(result).length ? result : undefined;
  }
  return undefined;
}

function normalizeArtifactReceipt(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const explicitReceipt = readRecord(payload, RECEIPT_KEYS);
  const receipt = sanitizeReceiptValue(explicitReceipt);
  const residency = sanitizeReceiptValue(readRecord(payload, ['residency']));
  const tts = sanitizeReceiptValue(readRecord(payload, ['tts']));
  const artifactId = readString(payload, ARTIFACT_ID_KEYS);
  const requestId = readString(payload, REQUEST_ID_KEYS);
  const receiptPath = readString(payload, RECEIPT_PATH_KEYS);
  const result: Record<string, unknown> = {
    ...(typeof receipt === 'object' && receipt ? (receipt as Record<string, unknown>) : {}),
    ...(typeof residency === 'object' && residency ? { residency } : {}),
    ...(typeof tts === 'object' && tts ? { tts } : {}),
    ...(artifactId ? { artifact_id: artifactId } : {}),
    ...(requestId ? { request_id: requestId } : {}),
    ...(receiptPath ? { receipt_path: receiptPath } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

function getGeneratedArtifactPreviewSourceKeys(payload: unknown): string[] {
  const record = parseRecord(payload);
  if (!record) return [];
  return dedupeStrings([...URL_KEYS, ...PATH_KEYS, ...RELATIVE_PATH_KEYS].map((key) => readString(record, [key])));
}

export function getGeneratedArtifactPayloadSourceKeys(payload: unknown): string[] {
  const record = parseRecord(payload);
  if (!record) return [];
  // `source_url` is dedupe-only by design: a hydrated video record carries its
  // remote origin there so the message-derived card for the same URL is
  // suppressed — while playback keeps reading the LOCAL path. It is
  // deliberately NOT in URL_KEYS, which also feeds source resolution.
  return dedupeStrings([...SOURCE_KEYS, 'source_url'].map((key) => readString(record, [key])));
}

export function getToolResultArtifactSourceKeys(resultDisplay: ToolResultDisplay): string[] {
  return getGeneratedArtifactPayloadSourceKeys(resultDisplay);
}

export function hasToolResultGeneratedArtifact(resultDisplay: ToolResultDisplay): boolean {
  const payload = parseRecord(resultDisplay);
  if (!payload) return false;
  const type = inferGeneratedArtifactType(payload);
  if (!type) return false;
  if (hasArtifactErrorOrUnverifiedReceipt(payload)) return false;
  const hasSource = getGeneratedArtifactPreviewSourceKeys(payload).length > 0;
  if (type === 'image' || type === 'video' || type === 'audio') return hasSource;
  if (type === 'html') return hasSource || Boolean(readString(payload, ['html', 'content']));
  return hasSource || Boolean(readString(payload, ['content', 'text']));
}

export function buildGeneratedArtifactFromToolResult(options: {
  conversation_id: string;
  call_id: string;
  source_message_id?: string;
  created_at?: number;
  name: string;
  description?: string;
  result_display: ToolResultDisplay;
}): IGeneratedConversationArtifact | undefined {
  const payload = parseRecord(options.result_display);
  if (!payload) return undefined;

  const artifactType = inferGeneratedArtifactType(payload);
  if (!artifactType || !hasToolResultGeneratedArtifact(options.result_display)) return undefined;

  const title =
    readString(payload, ['title', 'name', 'file_name', 'fileName']) ||
    readString(payload, RELATIVE_PATH_KEYS) ||
    options.description ||
    options.name;
  const description = readString(payload, ['description', 'prompt']) || options.description;
  const url = readString(payload, URL_KEYS);
  const path = readString(payload, PATH_KEYS);
  const relativePath = readString(payload, RELATIVE_PATH_KEYS);
  const fileName = readString(payload, ['file_name', 'fileName']);
  const mimeType = readString(payload, ['mime_type', 'media_type', 'mimeType', 'mediaType']);
  const size = readNumber(payload, ['size', 'bytes']);
  const html = readString(payload, ['html']);
  const content = readString(payload, ['content', 'text']);
  const artifactId = readString(payload, ARTIFACT_ID_KEYS);
  const requestId = readString(payload, REQUEST_ID_KEYS);
  const receiptPath = readString(payload, RECEIPT_PATH_KEYS);
  const sourceTool = readString(payload, ['source_tool', 'sourceTool']) || options.name;
  const receipt = normalizeArtifactReceipt(payload);

  return {
    id: `tool-artifact-${options.call_id}`,
    conversation_id: options.conversation_id,
    kind: artifactType,
    status: 'active',
    payload: {
      artifact_type: artifactType,
      title,
      description: description === title ? undefined : description,
      url,
      path,
      relative_path: relativePath,
      file_name: fileName,
      mime_type: mimeType,
      size,
      hash: readString(payload, ['hash']),
      provider: readString(payload, ['provider']),
      model: readString(payload, ['model']),
      artifact_id: artifactId,
      request_id: requestId,
      source_message_id: options.source_message_id,
      source_tool: sourceTool,
      receipt_path: receiptPath,
      receipt,
      html,
      content,
      error: readString(payload, ['error']),
    },
    created_at: options.created_at ?? Date.now(),
    updated_at: options.created_at ?? Date.now(),
  };
}
