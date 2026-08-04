/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.820.3 — the EDIT-AUTHORIZATION resolver: which single spend operation, if
 * any, this turn may carry.
 *
 * WHY THIS IS A SEPARATE GATE from `resolveMediaLaneIntent`
 * (mediaLaneIntentCore.ts). The visibility gate decides what the composer
 * SHOWS, and it is deliberately precision-first: "Gib der Aubergine ein
 * Gesicht." (no medium noun) shows NO pill and NO hint, and it stays that
 * way. But spend authority is a different question with a different cost of
 * error. An edit affordance that is hidden is merely quiet; a spend permit
 * minted for the wrong medium — or for no edit at all — is money. So the two
 * decisions live in two modules with two contracts:
 *
 *   - VISIBILITY (mediaLaneIntentCore): unchanged, explicit-noun-first;
 *   - AUTHORIZATION (this file): mutation semantics plus CANONICAL source
 *     truth, resolving the ONE operation the turn's spend permit will be bound
 *     to, or `null` — and `null` means NO permit is minted at all
 *     (fail-closed; there is no legacy default and no artifact-count
 *     heuristic).
 *
 * CANONICAL SOURCE TRUTH, because the CoS gate names it: the caller injects
 * per-medium availability computed by the SAME shared selector the envelope
 * and the paid handler use (`selectLatestVisibleMediaSourceArtifact`, which
 * applies `isVideoArtifactEditable` / the managed-image editability rule) —
 * never a bare "an artifact of this kind exists" count. A medium without a
 * canonically editable source resolves to `null`, and Hermes explains the
 * missing target honestly instead of the app pre-arming a spend that must be
 * refused.
 *
 * THE RESOLUTION ORDER:
 *
 *   1. EXPLICIT medium in the draft beats context. "Bearbeite das Video" over
 *      a conversation whose newest artifact is an image resolves `video_edit`
 *      — provided a canonically editable video exists; without one, `null`.
 *   2. CREATION intent resolves `null`: a creation turn carries no edit
 *      permit. (The explicit-edit predicates already veto strong creations,
 *      so this only catches pure creation messages.)
 *   3. CONTEXTUAL mutation — edit semantics WITHOUT a medium noun ("Gib der
 *      Aubergine ein Gesicht." right after the app's one editable video):
 *      the replied-to / actively selected artifact's medium wins when the
 *      caller supplies one; otherwise EXACTLY ONE canonically editable source
 *      medium decides. Both plausible, or neither, resolves `null` — an
 *      ambiguous turn gets no spend authority rather than a coin flip.
 *   4. Everything else — greetings, questions, opinions — is not a mutation
 *      and resolves `null`.
 *
 * PURE: no fs, no Electron, no IPC. The regex work is delegated to
 * `mediaLaneIntentCore` so the two gates share one definition of "mutation".
 */

import {
  hasMediaEditSemantics,
  isExplicitImageCreateRequest,
  isExplicitVideoCreateRequest,
  isExplicitVideoEditRequest,
  isImageEditRequest,
  isImageLaneRequest,
  type MediaLane,
} from './mediaLaneIntentCore';

/** The spend operations a turn's permit can be bound to. */
export type EditAuthorizationOperation = 'video_edit' | 'image_edit';

export interface EditAuthorizationInput {
  /** The raw draft text, exactly as typed. */
  message: string | null | undefined;
  /**
   * The medium of the artifact the user REPLIED TO or ACTIVELY SELECTED, when
   * that artifact is canonically editable. Context beats recency; the caller
   * passes `null`/`undefined` when there is no such target.
   */
  contextMedium?: MediaLane | null;
  /**
   * Per-medium CANONICAL editable-source availability — the shared selector's
   * answer, never an artifact count.
   */
  sources: { image: boolean; video: boolean };
}

/**
 * The ONE operation this turn's spend permit may authorise, or `null`.
 *
 * `null` is the common case and the safe one: ordinary turns, creations,
 * ambiguous media, and edits without a canonically editable source all carry
 * no permit, and the envelope then shows the registry with no spending
 * credential in it at all.
 */
export function resolveEditAuthorization(input: EditAuthorizationInput): EditAuthorizationOperation | null {
  const message = typeof input.message === 'string' ? input.message : '';
  const sources = input.sources;

  // 1. EXPLICIT medium beats context — but never without a canonically
  // editable source of that same medium.
  if (isExplicitVideoEditRequest(message)) return sources.video ? 'video_edit' : null;
  if (isImageEditRequest(message)) return sources.image ? 'image_edit' : null;

  // 2. A CREATION turn is not an edit turn. (Explicit edits already vetoed
  // strong creations above; this catches pure creation phrasings.)
  if (isExplicitVideoCreateRequest(message) || isExplicitImageCreateRequest(message) || isImageLaneRequest(message)) {
    return null;
  }

  // 3. CONTEXTUAL mutation: edit semantics with no medium noun. Context target
  // first, then exactly-one canonical source. Both or neither means ambiguous,
  // and ambiguous means no spend.
  if (!hasMediaEditSemantics(message)) return null;
  if (input.contextMedium === 'video') return 'video_edit';
  if (input.contextMedium === 'image') return 'image_edit';
  if (sources.video !== sources.image) return sources.video ? 'video_edit' : 'image_edit';
  return null;
}
