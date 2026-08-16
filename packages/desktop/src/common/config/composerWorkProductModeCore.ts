/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_COMMAND_EVE_IMAGE_MODEL_TIER,
  isCommandEveImageModelTierId,
  type CommandEveImageModelTierId,
} from './eveImageModelRegistryCore';

/**
 * Pure, process-neutral contract for the explicit work-product composer mode.
 *
 * A mode is authority only when it came from an explicit user selection. Draft
 * prose is intentionally absent from this module: mentioning an image, video or
 * document can never activate a paid or generative lane by itself.
 *
 * The selection is one-shot. Consuming it for a send always returns the neutral
 * chat state for the next turn. Artifact identity and content travel through the
 * existing artifact envelope; this contract carries only safe mode metadata.
 */

export const COMPOSER_WORK_PRODUCT_MODES = ['chat', 'image', 'video', 'presentation', 'pdf'] as const;

export type ComposerWorkProductMode = (typeof COMPOSER_WORK_PRODUCT_MODES)[number];
export type ComposerWorkProductModeOption = Exclude<ComposerWorkProductMode, 'chat'>;
export type ComposerWorkProductAction = 'chat' | 'create' | 'edit';
export type ComposerWorkProductAuthority = 'none' | 'explicit_user_selection';

export const COMPOSER_WORK_PRODUCT_REFERENCE_KINDS = [
  'image',
  'video',
  'presentation',
  'pdf',
  'document',
  'audio',
  'file',
] as const;

export type ComposerWorkProductReferenceKind = (typeof COMPOSER_WORK_PRODUCT_REFERENCE_KINDS)[number];

export const COMPOSER_IMAGE_ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
] as const;
export const COMPOSER_IMAGE_RESOLUTIONS = ['1K', '2K'] as const;

export type ComposerImageAspectRatio = (typeof COMPOSER_IMAGE_ASPECT_RATIOS)[number];
export type ComposerImageResolution = (typeof COMPOSER_IMAGE_RESOLUTIONS)[number];
export type ComposerImageOptions = Readonly<{
  tierId: CommandEveImageModelTierId;
  aspectRatio: ComposerImageAspectRatio;
  resolution: ComposerImageResolution;
}>;

export const DEFAULT_COMPOSER_IMAGE_OPTIONS: ComposerImageOptions = Object.freeze({
  tierId: DEFAULT_COMMAND_EVE_IMAGE_MODEL_TIER,
  aspectRatio: '16:9',
  resolution: '1K',
});

/** Language-neutral behavior metadata. Renderers provide localized strings. */
export type ComposerWorkProductModeDescriptor = Readonly<{
  mode: ComposerWorkProductMode;
  defaultAction: 'chat' | 'create';
  supportsReference: boolean;
  requiresExplicitUserSelection: boolean;
}>;

/** Language-neutral send semantics for each action. */
export type ComposerWorkProductActionDescriptor = Readonly<{
  action: ComposerWorkProductAction;
  requiresExplicitUserSelection: boolean;
  oneShot: boolean;
}>;

/** Localized copy supplied by a renderer boundary, never embedded in the core. */
export type LocalizedComposerWorkProductModeDescriptor = Readonly<{
  mode: ComposerWorkProductModeOption;
  label: string;
  tooltip: string;
}>;

/** Localized action copy supplied by a renderer boundary. */
export type LocalizedComposerWorkProductActionDescriptor = Readonly<{
  toolbarLabel: string;
  returnToChatLabel: string;
  selectedReferenceLabel: string;
  removeReferenceLabel: string;
}>;

export const COMPOSER_WORK_PRODUCT_MODE_DESCRIPTORS: readonly ComposerWorkProductModeDescriptor[] = [
  {
    mode: 'chat',
    defaultAction: 'chat',
    supportsReference: false,
    requiresExplicitUserSelection: false,
  },
  {
    mode: 'image',
    defaultAction: 'create',
    supportsReference: true,
    requiresExplicitUserSelection: true,
  },
  {
    mode: 'video',
    defaultAction: 'create',
    supportsReference: true,
    requiresExplicitUserSelection: true,
  },
  {
    mode: 'presentation',
    defaultAction: 'create',
    supportsReference: true,
    requiresExplicitUserSelection: true,
  },
  {
    mode: 'pdf',
    defaultAction: 'create',
    supportsReference: true,
    requiresExplicitUserSelection: true,
  },
] as const;

export const COMPOSER_WORK_PRODUCT_ACTION_DESCRIPTORS: readonly ComposerWorkProductActionDescriptor[] = [
  { action: 'chat', requiresExplicitUserSelection: false, oneShot: false },
  { action: 'create', requiresExplicitUserSelection: true, oneShot: true },
  { action: 'edit', requiresExplicitUserSelection: true, oneShot: true },
] as const;

const MODE_SET = new Set<string>(COMPOSER_WORK_PRODUCT_MODES);
const REFERENCE_KIND_SET = new Set<string>(COMPOSER_WORK_PRODUCT_REFERENCE_KINDS);
const IMAGE_ASPECT_RATIO_SET = new Set<string>(COMPOSER_IMAGE_ASPECT_RATIOS);
const IMAGE_RESOLUTION_SET = new Set<string>(COMPOSER_IMAGE_RESOLUTIONS);

/**
 * Parses persisted/IPC input fail-closed. Objects, boxed strings, oversized
 * values and unknown modes all become ordinary chat.
 */
export function parseComposerWorkProductMode(value: unknown): ComposerWorkProductMode {
  if (typeof value !== 'string' || value.length > 32) return 'chat';
  const candidate = value.trim().toLowerCase();
  return MODE_SET.has(candidate) ? (candidate as ComposerWorkProductMode) : 'chat';
}

/** Parses safe reference metadata without ever accepting an identity or path. */
export function parseComposerWorkProductReferenceKind(value: unknown): ComposerWorkProductReferenceKind | null {
  if (typeof value !== 'string' || value.length > 32) return null;
  const candidate = value.trim().toLowerCase();
  return REFERENCE_KIND_SET.has(candidate) ? (candidate as ComposerWorkProductReferenceKind) : null;
}

export type ComposerWorkProductSelection = Readonly<{
  mode: ComposerWorkProductMode;
  authority: ComposerWorkProductAuthority;
  hasSelectedReference: boolean;
  selectedReferenceKind: ComposerWorkProductReferenceKind | null;
  imageOptions: ComposerImageOptions | null;
}>;

export const DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION: ComposerWorkProductSelection = Object.freeze({
  mode: 'chat',
  authority: 'none',
  hasSelectedReference: false,
  selectedReferenceKind: null,
  imageOptions: null,
});

function parseComposerImageOptions(value: unknown): ComposerImageOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return DEFAULT_COMPOSER_IMAGE_OPTIONS;
  }
  const candidate = value as Partial<ComposerImageOptions>;
  const tierId = isCommandEveImageModelTierId(candidate.tierId)
    ? candidate.tierId
    : DEFAULT_COMPOSER_IMAGE_OPTIONS.tierId;
  const aspectRatio =
    typeof candidate.aspectRatio === 'string' && IMAGE_ASPECT_RATIO_SET.has(candidate.aspectRatio)
      ? (candidate.aspectRatio as ComposerImageAspectRatio)
      : DEFAULT_COMPOSER_IMAGE_OPTIONS.aspectRatio;
  const resolution =
    typeof candidate.resolution === 'string' && IMAGE_RESOLUTION_SET.has(candidate.resolution)
      ? (candidate.resolution as ComposerImageResolution)
      : DEFAULT_COMPOSER_IMAGE_OPTIONS.resolution;
  return Object.freeze({ tierId, aspectRatio, resolution });
}

/** Defensive IPC/session-storage parser. Unknown or partial input is chat. */
export function parseComposerWorkProductSelection(value: unknown): ComposerWorkProductSelection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION;
  }
  const candidate = value as Partial<ComposerWorkProductSelection>;
  if (candidate.authority !== 'explicit_user_selection') return DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION;
  const mode = parseComposerWorkProductMode(candidate.mode);
  if (mode === 'chat') return DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION;
  const hasSelectedReference = candidate.hasSelectedReference === true;
  return Object.freeze({
    mode,
    authority: 'explicit_user_selection',
    hasSelectedReference,
    selectedReferenceKind: hasSelectedReference
      ? parseComposerWorkProductReferenceKind(candidate.selectedReferenceKind)
      : null,
    imageOptions: mode === 'image' ? parseComposerImageOptions(candidate.imageOptions) : null,
  });
}

/**
 * The only constructor that grants work-product authority. Call it from a real
 * mode-control click, never from draft-text classification.
 */
export function selectExplicitComposerWorkProductMode(
  value: unknown,
  reference?: Readonly<{ selected: boolean; kind?: unknown }> | null,
  imageOptions?: unknown
): ComposerWorkProductSelection {
  const mode = parseComposerWorkProductMode(value);
  if (mode === 'chat') return DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION;

  const hasSelectedReference = reference?.selected === true;
  return Object.freeze({
    mode,
    authority: 'explicit_user_selection',
    hasSelectedReference,
    selectedReferenceKind: hasSelectedReference ? parseComposerWorkProductReferenceKind(reference?.kind) : null,
    imageOptions: mode === 'image' ? parseComposerImageOptions(imageOptions) : null,
  });
}

export type ComposerWorkProductPreparedRequest = Readonly<{
  mode: ComposerWorkProductModeOption;
  action: Exclude<ComposerWorkProductAction, 'chat'>;
  authority: 'explicit_user_selection';
  hasSelectedReference: boolean;
  selectedReferenceKind: ComposerWorkProductReferenceKind | null;
  imageOptions: ComposerImageOptions | null;
  preparedContext: string;
}>;

export type ConsumedComposerWorkProductSelection = Readonly<{
  request: ComposerWorkProductPreparedRequest | null;
  nextSelection: ComposerWorkProductSelection;
}>;

function normalizeExplicitSelection(
  value: unknown
): Omit<ComposerWorkProductPreparedRequest, 'preparedContext'> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<ComposerWorkProductSelection>;
  const mode = parseComposerWorkProductMode(candidate.mode);
  if (mode === 'chat' || candidate.authority !== 'explicit_user_selection') return null;

  const hasSelectedReference = candidate.hasSelectedReference === true;
  const selectedReferenceKind = hasSelectedReference
    ? parseComposerWorkProductReferenceKind(candidate.selectedReferenceKind)
    : null;
  const action = hasSelectedReference && !(mode === 'video' && selectedReferenceKind === 'image') ? 'edit' : 'create';
  return {
    mode,
    // A selected image in VIDEO mode is an image-to-video CREATE source. A
    // same-medium reference remains an immutable edit iteration.
    action,
    authority: 'explicit_user_selection',
    hasSelectedReference,
    selectedReferenceKind,
    imageOptions: mode === 'image' && action === 'create' ? parseComposerImageOptions(candidate.imageOptions) : null,
  };
}

/**
 * Renders the hidden model context from fixed allowlisted fields only.
 *
 * It deliberately has no parameter for a title, artifact id, local path, URL,
 * prompt, token or secret. The existing artifact envelope transports the
 * selected artifact separately.
 */
export function renderComposerWorkProductPreparedContext(value: unknown): string {
  const request = normalizeExplicitSelection(value);
  if (!request) return '';

  const imageOptionLines = request.imageOptions
    ? [
        `image_tier_id=${request.imageOptions.tierId}`,
        `image_resolution=${request.imageOptions.resolution}`,
        `image_aspect_ratio=${request.imageOptions.aspectRatio}`,
        'image_option_statement=Pass the exact selected resolution and aspect ratio to the image-generation tool.',
      ]
    : [];

  return [
    '[COMMAND_EVE_WORK_PRODUCT_CONTEXT]',
    'user_authority=explicit_user_selection',
    'authority_statement=The user explicitly selected this work-product mode for this send.',
    'scope=single_send',
    `mode=${request.mode}`,
    `action=${request.action}`,
    `reference_selected=${request.hasSelectedReference ? 'true' : 'false'}`,
    `reference_kind=${request.selectedReferenceKind ?? 'unspecified'}`,
    ...imageOptionLines,
    '[/COMMAND_EVE_WORK_PRODUCT_CONTEXT]',
  ].join('\n');
}

const SAFE_SELECTED_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;

/**
 * Pathless exact-target metadata for native AionCore/Hermes artifact lookup.
 * This is identity, never authority: edit authority is minted independently by
 * Main from the selectedArtifactIds IPC field and the active conversation.
 */
export function renderComposerSelectedArtifactPreparedContext(artifactId: unknown, referenceKind: unknown): string {
  const kind = parseComposerWorkProductReferenceKind(referenceKind);
  if (typeof artifactId !== 'string' || !SAFE_SELECTED_ARTIFACT_ID.test(artifactId) || !kind) return '';
  return [
    '[COMMAND_EVE_SELECTED_ARTIFACT]',
    `artifact_id=${artifactId}`,
    `reference_kind=${kind}`,
    'selection_statement=Use this exact existing conversation artifact as the source. Do not infer another artifact.',
    '[/COMMAND_EVE_SELECTED_ARTIFACT]',
  ].join('\n');
}

/**
 * Consumes explicit mode authority exactly once and resets the next turn to
 * chat. Invalid or text-derived lookalikes produce no prepared request.
 */
export function consumeComposerWorkProductSelection(value: unknown): ConsumedComposerWorkProductSelection {
  const normalized = normalizeExplicitSelection(value);
  if (!normalized) {
    return { request: null, nextSelection: DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION };
  }

  return {
    request: {
      ...normalized,
      preparedContext: renderComposerWorkProductPreparedContext(normalized),
    },
    nextSelection: DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION,
  };
}
