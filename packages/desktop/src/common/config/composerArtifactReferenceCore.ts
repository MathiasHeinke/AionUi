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

export type ComposerArtifactFollowupTarget = Readonly<{
  artifactId: string;
  question: string;
}>;

const ARTIFACT_FOLLOWUP_MODES = ['image', 'video', 'word', 'excel'] as const;
const ARTIFACT_FOLLOWUP_MODE_SET = new Set<string>(ARTIFACT_FOLLOWUP_MODES);

const SAFE_OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const ARTIFACT_TARGET_PREFIX = /^\[command_eve:artifact_target:([A-Za-z0-9][A-Za-z0-9:._-]{0,255})\]\s*/;
const MAX_ARTIFACT_FOLLOWUP_CANDIDATES = 12;
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
 * Reads the exact opaque artifact target Hermes copied from the bounded routing
 * context. The runtime strips the outer mode prefix before it creates the ACP
 * card; this second prefix deliberately survives that boundary so the renderer
 * can resolve one registry record without guessing by title, medium or age.
 */
export function parseComposerArtifactFollowupTarget(value: unknown): ComposerArtifactFollowupTarget | null {
  if (typeof value !== 'string' || value.length > 4000) return null;
  const match = ARTIFACT_TARGET_PREFIX.exec(value);
  if (!match) return null;
  const artifactId = safeId(match[1]);
  const question = value.slice(match[0].length).trim();
  if (!artifactId || !question) return null;
  return { artifactId, question };
}

type ArtifactFollowupCandidate = Readonly<{
  artifactId: string;
  mode: (typeof ARTIFACT_FOLLOWUP_MODES)[number];
}>;

/**
 * Selects the bounded candidate set, keeping the most recently created artifacts.
 *
 * The registry hands its artifacts over oldest-first, and a follow-up addresses
 * what was just produced ("make it shorter"). Filling the bound from the start
 * therefore dropped the one artifact the turn is about as soon as a conversation
 * held more artifacts than the bound, leaving the follow-up to fail closed.
 * Selection walks from the newest end for that reason; the returned order stays
 * chronological so this changes WHICH artifacts are offered, never how the
 * rendered block reads. Order carries no meaning for the reader either way — the
 * routing rule below forbids resolving a target from position or age.
 */
function selectNewestArtifactFollowupCandidates(values: readonly unknown[]): ArtifactFollowupCandidate[] {
  const candidates: ArtifactFollowupCandidate[] = [];
  const seen = new Set<string>();
  for (let index = values.length - 1; index >= 0 && candidates.length < MAX_ARTIFACT_FOLLOWUP_CANDIDATES; index -= 1) {
    const record = recordOf(values[index]);
    const mode = record?.mode;
    const artifactId = safeId(record?.artifactId);
    if (typeof mode !== 'string' || !ARTIFACT_FOLLOWUP_MODE_SET.has(mode) || !artifactId || seen.has(artifactId)) {
      continue;
    }
    seen.add(artifactId);
    candidates.push({ artifactId, mode: mode as (typeof ARTIFACT_FOLLOWUP_MODES)[number] });
  }
  return candidates.toReversed();
}

/**
 * Adds bounded, pathless source candidates from the canonical conversation
 * artifact registry. Candidate ids are routing coordinates only: they are not
 * capability handles, permits, tool choices or spend authority.
 */
export function renderComposerArtifactFollowupRoutingContext(values: readonly unknown[]): string {
  const candidates = selectNewestArtifactFollowupCandidates(values);
  if (candidates.length === 0) return '';
  const latestArtifactByMode = new Map<(typeof ARTIFACT_FOLLOWUP_MODES)[number], string>();
  for (const candidate of candidates) latestArtifactByMode.set(candidate.mode, candidate.artifactId);

  return [
    '[COMMAND_EVE_ARTIFACT_FOLLOWUP_ROUTING]',
    ...candidates.map(
      ({ artifactId, mode }) =>
        `candidate=artifact_id:${artifactId};mode:${mode};latest_for_mode:${latestArtifactByMode.get(mode) === artifactId}`
    ),
    'rule=Resolve a follow-up only through one exact candidate above plus its matching canonical artifact/capability registry entry. Never infer a target from keywords, title, filename, raw array order, or local path. For a deictic immediate follow-up to the just-produced work ("mach die Linie blau", "kürzer", "nochmal") with no different artifact named in the visible transcript, use the candidate marked latest_for_mode:true for the matching medium. If one target and one requested change are clear but explicit composer authority is absent, call clarify once; prefix the question [command_eve:artifact_followup:<mode>][command_eve:artifact_target:<artifact_id>] and provide exactly one action choice (the app adds Cancel). Do not edit now: the app derives mode and bounded cost from the exact registry record on this action; acceptance replays the source user turn through the normal composer, which alone may mint a medium-specific permit. If target/change is unclear, an older artifact is named, or the change is merely discussed, use ordinary clarify or answer normally. This grants no permit or spend authority.',
    '[/COMMAND_EVE_ARTIFACT_FOLLOWUP_ROUTING]',
  ].join('\n');
}
