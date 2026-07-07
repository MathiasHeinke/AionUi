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
const URL_KEYS = ['url', 'file_url', 'fileUrl', 'href', 'src', 'img_url', 'image_url', 'video_url', 'audio_url'];
const PATH_KEYS = ['path', 'file_path', 'filePath', 'absolute_path', 'absolutePath'];
const RELATIVE_PATH_KEYS = ['relative_path', 'relativePath'];
const SOURCE_KEYS = [...URL_KEYS, ...PATH_KEYS, ...RELATIVE_PATH_KEYS];

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

  const source = readString(payload, SOURCE_KEYS);
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
  if (readString(payload, ['html'])) return 'html';
  return inferTypeFromMimeOrSource(payload);
}

function dedupeStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

export function getGeneratedArtifactPayloadSourceKeys(payload: unknown): string[] {
  const record = parseRecord(payload);
  if (!record) return [];
  return dedupeStrings(SOURCE_KEYS.map((key) => readString(record, [key])));
}

export function getToolResultArtifactSourceKeys(resultDisplay: ToolResultDisplay): string[] {
  return getGeneratedArtifactPayloadSourceKeys(resultDisplay);
}

export function hasToolResultGeneratedArtifact(resultDisplay: ToolResultDisplay): boolean {
  const payload = parseRecord(resultDisplay);
  if (!payload) return false;
  const type = inferGeneratedArtifactType(payload);
  if (!type) return false;
  return (
    getGeneratedArtifactPayloadSourceKeys(payload).length > 0 ||
    Boolean(readString(payload, ['html', 'content', 'text', 'error']))
  );
}

export function buildGeneratedArtifactFromToolResult(options: {
  conversation_id: string;
  call_id: string;
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
      html,
      content,
      error: readString(payload, ['error']),
    },
    created_at: options.created_at ?? Date.now(),
    updated_at: options.created_at ?? Date.now(),
  };
}
