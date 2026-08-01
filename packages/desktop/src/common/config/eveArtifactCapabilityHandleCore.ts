/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 Variant C2 — WHICH artifact, and nothing about paying for it.
 *
 * The model must NEVER hand us a conversation id and have it treated as proof of
 * anything. A conversation id is guessable, it appears in transcripts, and a
 * model that hallucinates one would be granted exactly the authority it invented.
 * Scoping "by conversation" therefore cannot be enforced by asking the model
 * which conversation it is in.
 *
 * What CAN be enforced is possession. Main mints a high-entropy handle bound to
 * one specific `(conversation, artifact, artifact bytes, operation)` tuple and
 * emits it only into the context envelope of that conversation. Resolution is a
 * store lookup, and every mismatch is a refusal BEFORE any spend:
 *
 *   - a handle that is not well formed            -> refuse
 *   - a handle we never minted                    -> refuse
 *   - a handle minted for another conversation    -> refuse
 *   - a handle minted for another operation       -> refuse
 *   - a handle whose bytes changed on disk        -> refuse
 *
 * There is deliberately no "close enough" branch and no repair path.
 *
 * THE CORRECTION THAT MATTERS: a handle is now an IDENTIFIER WITH A FENCE, not a
 * purse. The first build let possession of one authorise a paid edit for
 * fourteen days, which — since the handle rides every turn's envelope out to a
 * third-party model API and is never revoked — amounted to shipping a reusable
 * key to a spending action. Spending is now authorised separately, by an
 * ephemeral single-use permit minted on a real user send
 * (`eveVideoEditSpendPermitCore`). Everything in this file is necessary for a
 * paid edit and, on its own, sufficient only for a read.
 *
 * PURE: no fs, no crypto import, no Electron. Randomness and file hashing are
 * injected, so every refusal branch above is reachable in a unit test without a
 * disk or a real random source.
 */

import { constantTimeAsciiEquals, isOpaqueToken, isSha256Hex, toLowerHex } from './eveOpaqueTokenCore';
import type { CommandEveVideoConversationArtifact } from './videoGenerationRequestCore';
import { hydrateVideoArtifactPayload, isVideoArtifactEditable } from './videoGenerationRequestCore';

/**
 * 32 bytes of randomness, hex-encoded. Not a design flourish: a handle names a
 * specific clip inside a specific conversation, so it has to be infeasible to
 * guess in the same sense a session token is. 32 bytes is the same width
 * `ensureCommandEveShimAuthToken` uses for the loopback nonce, and the minter
 * below refuses anything shorter rather than padding it.
 */
export const ARTIFACT_CAPABILITY_HANDLE_ENTROPY_BYTES = 32;

/**
 * A visible prefix so a handle is recognisable in a log or a transcript as a
 * capability and not as an identifier that could be looked up by other means.
 * The prefix carries no authority of its own — it is not part of the secret.
 */
export const ARTIFACT_CAPABILITY_HANDLE_PREFIX = 'evecap_';

/** The operations a handle can authorise. One handle authorises exactly one. */
export type ArtifactCapabilityOperation = 'video_edit';

/** The stored binding. This, not the model's word, is what a handle means. */
export interface ArtifactCapabilityGrant {
  handle: string;
  conversation_id: string;
  artifact_id: string;
  /** The SHA-256 of the artifact bytes AT MINT TIME. */
  artifact_sha256: string;
  operation: ArtifactCapabilityOperation;
  issued_at_ms: number;
}

export type ArtifactCapabilityRefusal =
  | 'handle-malformed'
  | 'handle-unknown'
  | 'conversation-mismatch'
  | 'operation-mismatch'
  | 'artifact-changed';

export type ArtifactCapabilityResolution =
  | { ok: true; grant: ArtifactCapabilityGrant }
  | { ok: false; reason: ArtifactCapabilityRefusal };

/**
 * Shape check only — this says nothing about whether we ever minted it. It is
 * the cheap filter that keeps a garbage string from reaching the store lookup at
 * all, so a store keyed on attacker-controlled text never sees arbitrary bytes.
 */
export function isWellFormedArtifactCapabilityHandle(value: unknown): value is string {
  return isOpaqueToken(value, ARTIFACT_CAPABILITY_HANDLE_PREFIX);
}

/**
 * Length-independent, content-constant-time comparison.
 *
 * The handle is a secret compared against a stored secret, so an early-exit
 * `===` would leak its prefix through timing to anything that can measure the
 * lookup. Both operands are already known to be fixed-width well-formed handles
 * by the time this runs; the length guard is a correctness backstop, not the
 * comparison itself.
 */
export function constantTimeHandleEquals(a: string, b: string): boolean {
  return constantTimeAsciiEquals(a, b);
}

/**
 * Mint a grant, or refuse.
 *
 * `undefined` is returned rather than a throw because every caller is on a path
 * where "no handle" is a legitimate outcome: an artifact that cannot be edited
 * simply gets no edit handle, and the envelope says so. A thrown error here
 * would have to be caught by the artifact-save path, which collapses every throw
 * into `video-artifact-save-failed` — a saved video would then report a lie.
 */
export function mintArtifactCapabilityGrant(input: {
  conversationId: string;
  artifactId: string;
  artifactSha256: string;
  operation: ArtifactCapabilityOperation;
  nowMs: number;
  randomBytes: (size: number) => Uint8Array;
}): ArtifactCapabilityGrant | undefined {
  if (typeof input.conversationId !== 'string' || input.conversationId.length === 0) return undefined;
  if (typeof input.artifactId !== 'string' || input.artifactId.length === 0) return undefined;
  if (!isSha256Hex(input.artifactSha256)) return undefined;
  if (input.operation !== 'video_edit') return undefined;

  let bytes: Uint8Array;
  try {
    bytes = input.randomBytes(ARTIFACT_CAPABILITY_HANDLE_ENTROPY_BYTES);
  } catch {
    return undefined;
  }
  // A short read from the random source is a silent downgrade of the ONLY thing
  // that makes a handle unguessable. Refuse rather than mint a weak one.
  if (!bytes || bytes.length !== ARTIFACT_CAPABILITY_HANDLE_ENTROPY_BYTES) return undefined;

  return {
    handle: `${ARTIFACT_CAPABILITY_HANDLE_PREFIX}${toLowerHex(bytes)}`,
    conversation_id: input.conversationId,
    artifact_id: input.artifactId,
    artifact_sha256: input.artifactSha256,
    operation: input.operation,
    issued_at_ms: input.nowMs,
  };
}

/**
 * Mint an EDIT handle for a stored artifact — and refuse for one that cannot be
 * edited.
 *
 * C6 in one function: a legacy clip whose length can be read back out of its own
 * durable description hydrates to a real duration and gets a handle; one whose
 * length cannot be recovered hydrates to `0`, is not editable, and gets none. A
 * handle that exists is therefore already a statement that the ceiling was
 * checked, rather than a promise to check it later.
 */
export function mintVideoEditCapabilityGrant(input: {
  artifact: CommandEveVideoConversationArtifact;
  nowMs: number;
  randomBytes: (size: number) => Uint8Array;
}): ArtifactCapabilityGrant | undefined {
  const payload = hydrateVideoArtifactPayload(input.artifact.payload);
  if (!isVideoArtifactEditable(payload)) return undefined;
  return mintArtifactCapabilityGrant({
    conversationId: input.artifact.conversation_id,
    artifactId: input.artifact.id,
    artifactSha256: payload.hash,
    operation: 'video_edit',
    nowMs: input.nowMs,
    randomBytes: input.randomBytes,
  });
}

/**
 * Turn a presented handle into an authorisation, or into a named refusal.
 *
 * `observedArtifactSha256` is the hash of the bytes ACTUALLY on disk right now,
 * computed by the caller. Comparing it against the grant is what stops a handle
 * from outliving the thing it points at: if the file was replaced, the handle
 * refers to content nobody authorised, and editing it would spend money on
 * something the user never saw.
 */
export function resolveArtifactCapabilityGrant(input: {
  handle: unknown;
  grant: ArtifactCapabilityGrant | undefined;
  conversationId: string;
  operation: ArtifactCapabilityOperation;
  observedArtifactSha256: string;
}): ArtifactCapabilityResolution {
  if (!isWellFormedArtifactCapabilityHandle(input.handle)) return { ok: false, reason: 'handle-malformed' };
  const grant = input.grant;
  if (!grant || !isWellFormedArtifactCapabilityHandle(grant.handle)) return { ok: false, reason: 'handle-unknown' };
  if (!constantTimeHandleEquals(grant.handle, input.handle)) return { ok: false, reason: 'handle-unknown' };
  if (grant.conversation_id !== input.conversationId) return { ok: false, reason: 'conversation-mismatch' };
  if (grant.operation !== input.operation) return { ok: false, reason: 'operation-mismatch' };
  if (
    !isSha256Hex(input.observedArtifactSha256) ||
    input.observedArtifactSha256 !== grant.artifact_sha256
  ) {
    return { ok: false, reason: 'artifact-changed' };
  }
  return { ok: true, grant };
}

/** A user-facing sentence for each refusal. Named causes, never one generic. */
export function describeArtifactCapabilityRefusal(reason: ArtifactCapabilityRefusal): string {
  switch (reason) {
    case 'handle-malformed':
      return 'Der Bezug auf das Video war unlesbar. Nenne das Video erneut.';
    case 'handle-unknown':
      return 'Dieser Videobezug ist unbekannt — es wurde nichts bearbeitet.';
    case 'conversation-mismatch':
      return 'Dieses Video gehört zu einer anderen Unterhaltung und kann hier nicht bearbeitet werden.';
    case 'operation-mismatch':
      return 'Dieser Videobezug erlaubt diese Aktion nicht.';
    case 'artifact-changed':
      return 'Die Videodatei hat sich seit dem Erstellen geändert — die Bearbeitung wurde abgebrochen.';
  }
}
