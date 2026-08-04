/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.820.3 — the STAGED-HANDLE contract for managed image generation.
 *
 * The defect this replaces: the managed image lane saved the generated PNG into
 * the conversation workspace and returned the ABSOLUTE PATH in model-visible
 * tool output (`Generated image saved to: /Users/<name>/…`). That ships the
 * account name to a third-party model API on every generation, and the image
 * never became a conversation artifact — no inline card, an empty Artefakte
 * tab, nothing a later turn could edit.
 *
 * The replacement is the video lane's architecture, applied to images:
 *
 *   1. STAGE — Main persists the verified provider BYTES privately and mints an
 *      opaque STAGED handle (`img_h_…`, minutes TTL). The model only ever sees
 *      the handle plus human metadata — never a path, never base64.
 *   2. BIND — the renderer reads the handle out of the finished turn's tool
 *      output and tells Main which conversation it belongs to. Only then does
 *      the record become `active` with a `conversation_id`, and only then does
 *      it get a durable edit capability grant (`evecap_…`, operation
 *      `image_edit`) that later envelopes may name.
 *   3. An unbound staged record expires and is purged — a handle found in a log
 *      tomorrow resolves to nothing.
 *
 * Why TWO handles with two prefixes: the staged handle is DISPLAY authority
 * (it says "this image exists; show it"), the capability handle is READ/EDIT
 * authority (it says "this conversation may act on these bytes"), and the spend
 * permit is SPEND authority. Collapsing them would let a token that rides a
 * transcript do work it was never scoped for.
 *
 * PURE: no fs, no crypto import, no Electron. Randomness is injected.
 */

import { isOpaqueToken, isSha256Hex, toLowerHex } from './eveOpaqueTokenCore';

/**
 * A visible prefix so a staged reference is recognisable in a transcript as a
 * STAGED image reference — deliberately different from `evecap_` (capability)
 * and `evespend_` (spend permit), because two credentials that look alike get
 * passed to each other's checks.
 */
export const IMAGE_STAGED_HANDLE_PREFIX = 'img_h_';

/** 32 bytes of randomness, hex-encoded — the same width as the shim token. */
export const IMAGE_STAGED_HANDLE_ENTROPY_BYTES = 32;

/**
 * How long a staged handle (and its unbound record) lives.
 *
 * Minutes, not days: the bind happens at the end of the very turn that produced
 * the image, so a longer window only extends how long a transcript-quoted
 * handle resolves. Thirty minutes covers a slow turn with margin.
 */
export const IMAGE_STAGED_HANDLE_TTL_MS = 30 * 60 * 1000;

/** Shape check only — says nothing about whether Main ever minted it. */
export function isWellFormedImageStagedHandle(value: unknown): value is string {
  return isOpaqueToken(value, IMAGE_STAGED_HANDLE_PREFIX);
}

/**
 * Mint a staged handle, or refuse.
 *
 * `undefined` rather than a throw: the caller is the generation path, where
 * "no handle" must become a named failure (`managed_image_stage_failed`), not
 * an exception escaping past the receipt verification.
 */
export function mintImageStagedHandle(input: { randomBytes: (size: number) => Uint8Array }): string | undefined {
  let bytes: Uint8Array;
  try {
    bytes = input.randomBytes(IMAGE_STAGED_HANDLE_ENTROPY_BYTES);
  } catch {
    return undefined;
  }
  // A short read from the random source silently downgrades the only thing that
  // makes the handle unguessable. Refuse rather than mint a weak one.
  if (!bytes || bytes.length !== IMAGE_STAGED_HANDLE_ENTROPY_BYTES) return undefined;
  return `${IMAGE_STAGED_HANDLE_PREFIX}${toLowerHex(bytes)}`;
}

/**
 * The durable payload of a managed image artifact.
 *
 * WHAT IS DELIBERATELY ABSENT: any filesystem path and any base64. The bytes
 * live in a private blob file Main alone reads; everyone else — the renderer,
 * the envelope, the model — refers to the artifact by id or by handle. The
 * `managed_image` marker is what tells the renderer to resolve its preview by
 * artifact id over IPC instead of looking for a path that will never exist.
 */
export type CommandEveManagedImageArtifactPayload = {
  artifact_type: 'image';
  title: string;
  description: string;
  /** Renderer contract: preview by artifact id via `commandEve.imageArtifactPreview`. */
  managed_image: true;
  mime_type: string;
  sha256: string;
  size: number;
  /** The registry tier the image was PRODUCED at — an edit inherits, never picks. */
  tier: string;
  model: string;
  resolution: string;
  aspect_ratio: string;
  prompt_sha256: string;
  /** Set only on derived images — the artifact this one was edited FROM. */
  parent_artifact_id?: string;
};

/**
 * The durable record. `conversation_id` is `null` while the record is `staged`:
 * the conversation is DISPLAY authority the renderer grants at bind time, and a
 * record that claims one earlier would be scoped by nobody's decision.
 */
export type CommandEveManagedImageArtifact = {
  id: string;
  conversation_id: string | null;
  kind: 'image';
  status: 'staged' | 'active';
  payload: CommandEveManagedImageArtifactPayload;
  created_at: number;
  updated_at: number;
  /**
   * The ACP tool call whose output carried the staged handle, recorded at bind.
   * This is what makes a re-delivered terminal bind a no-op instead of a second
   * artifact: the same tool call binding twice binds nothing twice.
   */
  bound_tool_call_id?: string;
};

/** A record after bind: conversation-scoped and displayable. */
export type CommandEveActiveImageArtifact = CommandEveManagedImageArtifact & {
  conversation_id: string;
  status: 'active';
};

/**
 * The model-visible tool text for the managed lane (K2 contract, German to
 * match the lane's existing tool voice).
 *
 * PATH-FREE BY CONSTRUCTION: it is assembled from the handle and human metadata
 * only, so there is no parameter through which a path, a `file:` URL, a
 * `MEDIA:` directive or a `data:image` payload could reach the transcript.
 *
 * NO EDIT INSTRUCTION, on purpose (CoS 1.820.3): the staged handle is
 * STAGE/BIND/DISPLAY authority only. Editing runs on the DISTINCT `evecap_`
 * capability handle, which the bound conversation's envelope supplies — a text
 * that told the model to "use this reference for edits" would conflate the two
 * credentials and invite the staged handle to be presented where only a
 * capability handle resolves.
 */
export function buildManagedImageToolText(input: {
  artifactHandle: string;
  resolution: string;
  aspectRatio: string;
  bytesCount: number;
  model?: string;
}): string {
  const sizeKb = Math.max(1, Math.round(input.bytesCount / 1024));
  const quality = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : 'unbekannt';
  return `Bild erstellt. Interne Artefakt-Referenz: ${input.artifactHandle} (${input.resolution} · ${input.aspectRatio} · ${sizeKb} KB · Qualität ${quality}).`;
}

/**
 * The id/conversation-id shape this lane writes: 1–128 chars, first char
 * alphanumeric, the rest alphanumeric or `:._-`.
 *
 * A character-code scan rather than a regex, for the same reason the rest of
 * the paid path carries none: the semantic gate over this path bans
 * string-matching primitives outright so a structural test never has to tell
 * a shape check from a classifier. An id outside this shape is a record this
 * lane did not write, and it is refused rather than repaired.
 */
function isSafeRecordId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    const isExtra = code === 58 || code === 46 || code === 95 || code === 45; // : . _ -
    if (i === 0 && !isDigit && !isUpper && !isLower) return false;
    if (!isDigit && !isUpper && !isLower && !isExtra) return false;
  }
  return true;
}

/** A bounded, non-empty human string — titles, descriptions, model names. */
function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

/** A finite, positive millisecond timestamp — not merely `typeof number`. */
function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Conservative record validation for JSON read back from disk.
 *
 * EVERY typed field is validated — no partially-checked object is cast into
 * the full type. A record that fails anywhere is not a record: it is refused
 * whole, because a store that half-trusts its own JSON makes every later
 * check (hash, conversation fence, editability) a check over guessed data.
 */
export function parseManagedImageArtifactRecord(value: unknown): CommandEveManagedImageArtifact | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !isSafeRecordId(record.id) ||
    (record.conversation_id !== null && !isSafeRecordId(record.conversation_id)) ||
    record.kind !== 'image' ||
    (record.status !== 'staged' && record.status !== 'active') ||
    !isFiniteTimestamp(record.created_at) ||
    !isFiniteTimestamp(record.updated_at) ||
    (record.bound_tool_call_id !== undefined && !isBoundedText(record.bound_tool_call_id, 256))
  ) {
    return undefined;
  }
  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const p = payload as Record<string, unknown>;
  if (
    p.artifact_type !== 'image' ||
    p.managed_image !== true ||
    !isBoundedText(p.title, 256) ||
    !isBoundedText(p.description, 1024) ||
    !isBoundedText(p.mime_type, 64) ||
    !isSha256Hex(p.sha256) ||
    typeof p.size !== 'number' ||
    !Number.isFinite(p.size) ||
    p.size <= 0 ||
    !isBoundedText(p.tier, 64) ||
    !isBoundedText(p.model, 256) ||
    !isBoundedText(p.resolution, 32) ||
    !isBoundedText(p.aspect_ratio, 32) ||
    !isSha256Hex(p.prompt_sha256) ||
    (p.parent_artifact_id !== undefined && !isSafeRecordId(p.parent_artifact_id))
  ) {
    return undefined;
  }
  // A staged record claiming a conversation — or an active one claiming none —
  // is a state this lane never writes, so it is refused rather than repaired.
  if (record.status === 'staged' && record.conversation_id !== null) return undefined;
  if (record.status === 'active' && typeof record.conversation_id !== 'string') return undefined;
  return record as unknown as CommandEveManagedImageArtifact;
}
