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
 * The MODE is sticky (founder ruling 2026-08-18). Staying in "create an image"
 * across turns is what makes the lane legible to both the operator ("I am still
 * in image mode, it says so above the input") and to Hermes, which receives the
 * same prepared context on every turn instead of only the first.
 *
 * THE REFERENCE FOLLOWS THE WORK, and only on an EDIT (founder ruling
 * 2026-08-18, second pass). Three outcomes were possible and two of them are
 * wrong. Carrying the ORIGINAL forward is wrong: "and now make it blue" would
 * silently re-edit the first image and throw away the step the operator just
 * approved. Dropping the reference is equally wrong: the same sentence would
 * then start a NEW image from the words "make it blue", which is not what anyone
 * asked for. What is right is carrying the RESULT: each step builds on the one
 * visible above it, which is how "orange — no, green — wait, blue" is supposed
 * to feel.
 *
 * This module keeps the safe half of that promise: an edit keeps its reference
 * ARMED so the lane stays an edit lane. Which artifact the reference points at
 * is renderer state, because only the renderer can see whether a successor was
 * actually produced. That split matters for the failure case: no successor means
 * nothing moves, and the retry hits the same source.
 *
 * A CREATE still drops its reference. A selected image in VIDEO mode is an
 * image-to-video create source, so it is consumed by the render that used it —
 * carrying it would re-render the same clip from the same still.
 *
 * THE COST PROPERTY IS UNCHANGED, and it is worth naming why neither stickiness
 * nor a surviving reference weakens it. Authority still only ever comes from
 * `selectExplicitComposerWorkProductMode`,
 * i.e. from a real click on a mode control; draft prose can no more activate a
 * paid lane after this change than before it. What used to bound the exposure was
 * amnesia — the mode forgot itself after one send. What bounds it now is
 * VISIBILITY plus an always-present exit: the active lane is rendered above the
 * input for as long as it is armed, and one click on its × returns to chat. An
 * intent the operator can see and cancel at any moment is a held intent, not a
 * stale one.
 *
 * An armed reference is likewise not a spend: it is the STATEMENT of a target,
 * never a permit for it. Every paid edit still mints its single-use permit at
 * send time, bound to that turn's own text, and a reference that merely persists
 * mints nothing and debits nothing.
 *
 * Artifact identity and content travel through the existing artifact envelope;
 * this contract carries only safe mode metadata.
 */

export const COMPOSER_WORK_PRODUCT_MODES = ['chat', 'image', 'video', 'presentation', 'pdf', 'word', 'excel'] as const;

export type ComposerWorkProductMode = (typeof COMPOSER_WORK_PRODUCT_MODES)[number];
export type ComposerWorkProductModeOption = Exclude<ComposerWorkProductMode, 'chat'>;
export type ComposerWorkProductAction = 'chat' | 'create' | 'edit';
export type ComposerWorkProductAuthority = 'none' | 'explicit_user_selection';

export const COMPOSER_WORK_PRODUCT_REFERENCE_KINDS = [
  'image',
  'video',
  'presentation',
  'pdf',
  'word',
  'excel',
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
  {
    mode: 'word',
    defaultAction: 'create',
    supportsReference: true,
    requiresExplicitUserSelection: true,
  },
  {
    mode: 'excel',
    defaultAction: 'create',
    supportsReference: true,
    requiresExplicitUserSelection: true,
  },
] as const;

export const COMPOSER_WORK_PRODUCT_ACTION_DESCRIPTORS: readonly ComposerWorkProductActionDescriptor[] = [
  { action: 'chat', requiresExplicitUserSelection: false, oneShot: false },
  { action: 'create', requiresExplicitUserSelection: true, oneShot: false },
  { action: 'edit', requiresExplicitUserSelection: true, oneShot: false },
] as const;

const MODE_SET = new Set<string>(COMPOSER_WORK_PRODUCT_MODES);
const REFERENCE_KIND_SET = new Set<string>(COMPOSER_WORK_PRODUCT_REFERENCE_KINDS);
const IMAGE_ASPECT_RATIO_SET = new Set<string>(COMPOSER_IMAGE_ASPECT_RATIOS);
const IMAGE_RESOLUTION_SET = new Set<string>(COMPOSER_IMAGE_RESOLUTIONS);

/**
 * Modes whose agentic workflow may create one managed raster image as part of
 * the selected work product. Video owns a separate media contract; chat owns
 * none. Keeping this predicate in the authority core prevents the start and
 * conversation composers from drifting onto different model/quote surfaces.
 */
export function composerWorkProductModeSupportsImageGeneration(value: unknown): boolean {
  const mode = parseComposerWorkProductMode(value);
  return mode === 'image' || mode === 'presentation' || mode === 'pdf' || mode === 'word' || mode === 'excel';
}

function selectionCarriesImageOptions(mode: ComposerWorkProductModeOption, hasSelectedReference: boolean): boolean {
  return (
    mode === 'image' ||
    (!hasSelectedReference && mode !== 'video' && composerWorkProductModeSupportsImageGeneration(mode))
  );
}

export const COMPOSER_OFFICE_STUDIO_SKILL_ID = 'office-studio';
export const COMPOSER_PRESENTATION_STUDIO_SKILL_ID = 'presentation-studio';
export const COMPOSER_PDF_STUDIO_SKILL_ID = 'editorial-pdf-design';

/** Explicit document selections bind the app-owned workflow to this turn. */
export function resolveComposerWorkProductInjectedSkills(value: unknown): readonly string[] {
  const mode = parseComposerWorkProductMode(value);
  if (mode === 'word' || mode === 'excel') return [COMPOSER_OFFICE_STUDIO_SKILL_ID];
  if (mode === 'presentation') return [COMPOSER_PRESENTATION_STUDIO_SKILL_ID];
  return mode === 'pdf' ? [COMPOSER_PDF_STUDIO_SKILL_ID] : [];
}

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
    imageOptions: selectionCarriesImageOptions(mode, hasSelectedReference)
      ? parseComposerImageOptions(candidate.imageOptions)
      : null,
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
    imageOptions: selectionCarriesImageOptions(mode, hasSelectedReference)
      ? parseComposerImageOptions(imageOptions)
      : null,
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
  const action = hasSelectedReference && selectedReferenceKind === mode ? 'edit' : 'create';
  return {
    mode,
    // A cross-medium reference is an immutable CREATE input. Only an exact
    // same-medium reference is an edit target and may mint edit authority.
    action,
    authority: 'explicit_user_selection',
    hasSelectedReference,
    selectedReferenceKind,
    imageOptions: selectionCarriesImageOptions(mode, hasSelectedReference)
      ? parseComposerImageOptions(candidate.imageOptions)
      : null,
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
        'image_prompt_statement=Build a self-contained English image prompt from the established conversation intent plus this turn; never forward only a short follow-up sentence.',
        'image_authority_statement=These fields describe the app selection. Tool execution follows the current Hermes permission mode; never request, invent or expose an internal billing receipt.',
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
 * Consumes explicit mode authority for THIS turn and returns the selection the
 * composer should hold for the next one. The mode always survives. The bound
 * reference survives an EDIT and is dropped by a CREATE (see the module header).
 * Invalid or text-derived lookalikes produce no prepared request and fall back
 * to chat.
 */
export function consumeComposerWorkProductSelection(value: unknown): ConsumedComposerWorkProductSelection {
  const normalized = normalizeExplicitSelection(value);
  if (!normalized) {
    return { request: null, nextSelection: DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION };
  }

  // The action table decides, not this function: a `oneShot` action still
  // collapses to chat, so a future one-shot lane needs no change here.
  const descriptor = COMPOSER_WORK_PRODUCT_ACTION_DESCRIPTORS.find(
    (candidate) => candidate.action === normalized.action
  );
  // An edit lane stays an edit lane. The renderer re-points the reference at the
  // successor once one exists; keeping `hasSelectedReference` true here is what
  // stops the next turn from silently becoming a CREATE — which would answer
  // "and now make the line blue" with a brand new image built from those words.
  const keepsReference = normalized.action === 'edit' && normalized.hasSelectedReference;
  const nextSelection =
    descriptor && descriptor.oneShot === false
      ? // `selectExplicitComposerWorkProductMode` is the only authority
        // constructor, so re-arming through it keeps the "authority comes from a
        // click" invariant intact across turns — for the mode and for a
        // surviving edit reference alike.
        selectExplicitComposerWorkProductMode(
          normalized.mode,
          keepsReference ? { selected: true, kind: normalized.selectedReferenceKind } : undefined,
          normalized.imageOptions ?? undefined
        )
      : DEFAULT_COMPOSER_WORK_PRODUCT_SELECTION;

  return {
    request: {
      ...normalized,
      preparedContext: renderComposerWorkProductPreparedContext(normalized),
    },
    nextSelection,
  };
}
