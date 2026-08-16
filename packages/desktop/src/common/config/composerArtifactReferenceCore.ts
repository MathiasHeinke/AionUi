/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ComposerWorkProductModeOption, ComposerWorkProductReferenceKind } from './composerWorkProductModeCore';

export type ComposerArtifactReference = Readonly<{
  artifactId: string;
  conversationId: string;
  title: string;
  mode: ComposerWorkProductModeOption;
  referenceKind: Extract<
    ComposerWorkProductReferenceKind,
    'image' | 'video' | 'presentation' | 'pdf' | 'word' | 'excel'
  >;
  managedImage: boolean;
}>;

const ARTIFACT_FOLLOWUP_MODES = ['image', 'video', 'word', 'excel'] as const;
const ARTIFACT_FOLLOWUP_MODE_SET = new Set<string>(ARTIFACT_FOLLOWUP_MODES);

const SAFE_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const MAX_TITLE_CHARS = 120;
const MIME_KEYS = ['mime_type', 'media_type', 'mimeType'] as const;
const SOURCE_KEYS = ['path', 'file_path', 'filePath', 'url', 'file_url', 'fileUrl', 'name', 'file_name'] as const;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function safeId(value: unknown): string | null {
  return typeof value === 'string' && SAFE_OPAQUE_ID.test(value) ? value : null;
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function safeTitle(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const title = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS);
  return title || fallback;
}

function extensionOf(value: string | null): string {
  const withoutQuery = value?.split('?')[0]?.split('#')[0] ?? '';
  return withoutQuery.split(/[\\/]/).at(-1)?.split('.').at(-1)?.toLowerCase() ?? '';
}

function inferMode(
  artifact: Record<string, unknown>,
  payload: Record<string, unknown>
): ComposerArtifactReference['mode'] | null {
  const explicit = readString(payload, ['artifact_type', 'type', 'kind'])?.toLowerCase();
  const outerKind = typeof artifact.kind === 'string' ? artifact.kind.toLowerCase() : '';
  const mime = readString(payload, MIME_KEYS)?.toLowerCase() ?? '';
  const extension = extensionOf(readString(payload, SOURCE_KEYS));

  if (explicit === 'image' || outerKind === 'image' || mime.startsWith('image/')) return 'image';
  if (explicit === 'video' || outerKind === 'video' || mime.startsWith('video/')) return 'video';
  if (explicit === 'presentation' || outerKind === 'presentation') return 'presentation';
  if (
    extension === 'ppt' ||
    extension === 'pptx' ||
    mime === 'application/vnd.ms-powerpoint' ||
    mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return 'presentation';
  }
  if (explicit === 'pdf' || outerKind === 'pdf' || extension === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (
    explicit === 'word' ||
    outerKind === 'word' ||
    extension === 'docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'word';
  }
  if (
    explicit === 'excel' ||
    outerKind === 'excel' ||
    extension === 'xlsx' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return 'excel';
  }
  return null;
}

/**
 * Converts renderer/backend artifact data into a pathless, bounded reference.
 * Paths and URLs may help identify the file type but are never returned.
 */
export function resolveComposerArtifactReference(value: unknown): ComposerArtifactReference | null {
  const artifact = recordOf(value);
  if (!artifact || (artifact.status !== 'active' && artifact.status !== 'saved')) return null;
  const artifactId = safeId(artifact.id);
  const conversationId = safeId(artifact.conversation_id);
  const payload = recordOf(artifact.payload);
  if (!artifactId || !conversationId || !payload) return null;

  const mode = inferMode(artifact, payload);
  if (!mode) return null;
  const fallback =
    mode === 'image'
      ? 'Bild'
      : mode === 'video'
        ? 'Video'
        : mode === 'presentation'
          ? 'Präsentation'
          : mode === 'pdf'
            ? 'PDF'
            : mode === 'word'
              ? 'Word'
              : 'Excel';
  const title = safeTitle(readString(payload, ['title', 'name', 'file_name']), fallback);

  return {
    artifactId,
    conversationId,
    title,
    mode,
    referenceKind: mode,
    managedImage: mode === 'image' && payload.managed_image === true,
  };
}

/**
 * Adds a bounded, pathless hint only when this conversation has usable
 * artifacts. It carries no id, handle, permit, tool choice or spend authority.
 */
export function renderComposerArtifactFollowupRoutingContext(values: readonly unknown[]): string {
  const available = new Set<string>();
  for (const value of values) {
    const record = recordOf(value);
    const mode = record?.mode;
    if (typeof mode === 'string' && ARTIFACT_FOLLOWUP_MODE_SET.has(mode)) available.add(mode);
  }
  const modes = ARTIFACT_FOLLOWUP_MODES.filter((mode) => available.has(mode));
  if (modes.length === 0) return '';

  return [
    '[COMMAND_EVE_ARTIFACT_FOLLOWUP_ROUTING]',
    `available_modes=${modes.join(',')}`,
    'rule=For one clear requested change to the latest matching artifact, call clarify once; prefix the question [command_eve:artifact_followup:<mode>] and provide exactly one action choice (the app adds Cancel). Do not edit now: the app replays acceptance through the normal composer. If target/change is unclear or merely discussed, use ordinary clarify or answer normally. This grants no permit or spend authority.',
    '[/COMMAND_EVE_ARTIFACT_FOLLOWUP_ROUTING]',
  ].join('\n');
}
