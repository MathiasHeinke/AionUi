/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IGeneratedArtifactType, IGeneratedConversationArtifact } from '@/common/adapter/ipcBridge';

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'heic', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp']);
const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'webm']);
const AUDIO_EXTENSIONS = new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav']);
const HTML_EXTENSIONS = new Set(['htm', 'html']);
const FILE_EXTENSIONS = new Set([
  '7z',
  'css',
  'csv',
  'doc',
  'docx',
  'epub',
  'gz',
  'js',
  'json',
  'jsx',
  'md',
  'markdown',
  'odp',
  'ods',
  'odt',
  'pdf',
  'ppt',
  'pptx',
  'py',
  'rtf',
  'sh',
  'sql',
  'tar',
  'tgz',
  'toml',
  'ts',
  'tsv',
  'tsx',
  'txt',
  'xls',
  'xlsx',
  'xml',
  'yaml',
  'yml',
  'zip',
]);
const ALL_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...HTML_EXTENSIONS,
  ...FILE_EXTENSIONS,
].toSorted((a, b) => b.length - a.length);

function unwrapSource(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed.at(-1);
  if (trimmed.length >= 2 && first === last && ['`', '"', "'"].includes(first)) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function getExtension(source: string): string | undefined {
  let pathname = source;
  if (/^https:\/\//i.test(source)) {
    try {
      pathname = new URL(source).pathname;
    } catch {
      return undefined;
    }
  }
  const fileName = pathname.replace(/\\/g, '/').split('/').pop();
  const extension = fileName?.includes('.') ? fileName.split('.').pop()?.toLowerCase() : undefined;
  return extension || undefined;
}

function getArtifactType(source: string): IGeneratedArtifactType | undefined {
  const extension = getExtension(source);
  if (!extension) return undefined;
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (HTML_EXTENSIONS.has(extension)) return 'html';
  if (FILE_EXTENSIONS.has(extension)) return 'file';
  return undefined;
}

function isAllowedSource(source: string): boolean {
  if (!source || source.includes('\0') || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(source)) return false;
  const isAbsolutePath = source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source);
  if (!isAbsolutePath && !/^https:\/\//i.test(source)) return false;
  return Boolean(getArtifactType(source));
}

function extractSource(value: string): { source: string; trailingText?: string } | undefined {
  const unwrapped = unwrapSource(value);
  if (isAllowedSource(unwrapped)) return { source: unwrapped };

  const extensionRegex = new RegExp(`\\.(?:${ALL_EXTENSIONS.join('|')})`, 'gi');
  for (const match of unwrapped.matchAll(extensionRegex)) {
    const end = (match.index ?? -1) + match[0].length;
    if (end <= 0 || end >= unwrapped.length) continue;
    const source = unwrapped.slice(0, end);
    const suffix = unwrapped.slice(end);
    if (!isAllowedSource(source) || !/^(?:\s|[A-Z\u00c4\u00d6\u00dc])/.test(suffix)) continue;
    return { source, trailingText: suffix.trimStart() || undefined };
  }
  return undefined;
}

function getTitle(source: string): string {
  let pathname = source;
  if (/^https:\/\//i.test(source)) {
    try {
      pathname = new URL(source).pathname;
    } catch {
      // The source has already passed URL validation. Fall back to the raw value.
    }
  }
  const title = pathname.replace(/\\/g, '/').split('/').pop() || source;
  try {
    return decodeURIComponent(title);
  } catch {
    return title;
  }
}

export type HermesMediaDirective = {
  source: string;
  artifactType: IGeneratedArtifactType;
  title: string;
};

export function parseHermesMediaDirectives(content: string): {
  text: string;
  directives: HermesMediaDirective[];
} {
  const directives: HermesMediaDirective[] = [];
  const seenSources = new Set<string>();
  const retainedLines: string[] = [];

  for (const line of content.split('\n')) {
    const match = line.match(/^[\t ]*(?:\*\*|__)?MEDIA:(?:\*\*|__)?[\t ]*(.+?)[\t ]*$/i);
    if (!match) {
      retainedLines.push(line);
      continue;
    }

    const extracted = extractSource(match[1]);
    if (!extracted) {
      retainedLines.push(line);
      continue;
    }
    const artifactType = getArtifactType(extracted.source);
    if (!artifactType) {
      retainedLines.push(line);
      continue;
    }
    if (extracted.trailingText) retainedLines.push(extracted.trailingText);
    if (seenSources.has(extracted.source)) continue;
    seenSources.add(extracted.source);
    directives.push({ source: extracted.source, artifactType, title: getTitle(extracted.source) });
  }

  return {
    text: retainedLines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd(),
    directives,
  };
}

export function buildGeneratedArtifactFromHermesMediaDirective(options: {
  conversation_id: string;
  message_id: string;
  index: number;
  created_at?: number;
  directive: HermesMediaDirective;
}): IGeneratedConversationArtifact {
  const isRemote = /^https:\/\//i.test(options.directive.source);
  const createdAt = (options.created_at ?? Date.now()) + (options.index + 1) / 1000;
  return {
    id: `hermes-media-${options.message_id}-${options.index}`,
    conversation_id: options.conversation_id,
    kind: options.directive.artifactType,
    status: 'active',
    payload: {
      artifact_type: options.directive.artifactType,
      title: options.directive.title,
      url: isRemote ? options.directive.source : undefined,
      path: isRemote ? undefined : options.directive.source,
      source_tool: 'hermes_media_directive',
    },
    created_at: createdAt,
    updated_at: createdAt,
  };
}
