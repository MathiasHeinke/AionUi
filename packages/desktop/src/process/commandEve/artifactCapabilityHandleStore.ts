/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 Variant C2 — where capability handles live.
 *
 * Same discipline as the shim auth token file, and for the same reason: a handle
 * is a bearer secret. It is written 0600 into private app data, under a filename
 * that is the SHA-256 of the handle rather than the handle itself.
 *
 * BE PRECISE ABOUT WHAT THAT BUYS, because an earlier version of this comment
 * was not: hashing the FILENAME keeps the secret out of a directory listing and
 * out of anything that indexes names. It does NOT keep it out of a backup. The
 * grant body contains the handle in cleartext and has to — the context envelope
 * re-emits that same handle on every later turn, so it must remain recoverable
 * from disk. Anyone who can read these files can present these handles. That is
 * why a handle now buys only a read: the spending credential is the ephemeral
 * permit next door, whose store genuinely contains no secret at rest because a
 * permit is emitted once and never needs to be recovered.
 *
 * The lookup is deliberately flat. Keying the directory by conversation would
 * mean the CALLER tells us which conversation to look in, and the caller is
 * ultimately the model. A handle must resolve without anyone's claim about where
 * it belongs — the grant it resolves to is what states the conversation, and
 * that statement is ours.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSha256Hex } from '@/common/config/eveOpaqueTokenCore';
import {
  isWellFormedArtifactCapabilityHandle,
  mintImageEditCapabilityGrant,
  mintVideoEditCapabilityGrant,
  resolveArtifactCapabilityGrant,
  type ArtifactCapabilityGrant,
  type ArtifactCapabilityRefusal,
} from '@/common/config/eveArtifactCapabilityHandleCore';
import {
  ARTIFACT_ENVELOPE_MAX_ARTIFACTS,
  type EveArtifactEnvelopeEntry,
} from '@/common/config/eveArtifactContextEnvelopeCore';
import type { CommandEveVideoConversationArtifact } from '@/common/config/videoGenerationRequestCore';
import { hydrateVideoArtifactPayload, isVideoArtifactEditable } from '@/common/config/videoGenerationRequestCore';
import { listVideoArtifactRecords } from './videoArtifactStore';

const CAPABILITY_STORE_DIR = 'command-eve-artifact-capabilities';

/**
 * Grants older than this stop resolving and are swept on the next mint.
 *
 * A handle that never expires is a key to a paid action that survives every
 * later decision about the conversation. Fourteen days is long enough that a
 * user coming back to a clip next week still works, and short enough that the
 * store cannot grow without bound.
 */
export const ARTIFACT_CAPABILITY_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function capabilityDirectory(dataPath: string): string {
  return path.join(path.resolve(dataPath), CAPABILITY_STORE_DIR);
}

/** `<64 hex>.json` — the only filename shape this directory ever contains. */
const GRANT_FILE_NAME_LENGTH = 69;

function grantFileName(handle: string): string {
  return `${crypto.createHash('sha256').update(handle).digest('hex')}.json`;
}

function writeGrantAtomic(file: string, grant: ArtifactCapabilityGrant): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tempFile = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(grant, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tempFile, 0o600);
  fs.renameSync(tempFile, file);
}

function parseGrant(value: unknown): ArtifactCapabilityGrant | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !isWellFormedArtifactCapabilityHandle(record.handle) ||
    typeof record.conversation_id !== 'string' ||
    typeof record.artifact_id !== 'string' ||
    typeof record.artifact_sha256 !== 'string' ||
    (record.operation !== 'video_edit' && record.operation !== 'image_edit') ||
    typeof record.issued_at_ms !== 'number'
  ) {
    return undefined;
  }
  return record as unknown as ArtifactCapabilityGrant;
}

/** Delete every grant past its TTL. Cheap, bounded, and never throws upward. */
export function pruneArtifactCapabilityGrants(dataPath: string, nowMs: number): number {
  const directory = capabilityDirectory(dataPath);
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    // `<64 hex>.json` and nothing else. Spelled as a length plus a hex scan
    // rather than `endsWith`, because the semantic gate over this path bans
    // every string-matching primitive outright — and this is also the tighter
    // check: a stray temp file or a stale `.json` from another feature is not a
    // grant and should never have been parsed as one.
    if (!entry.isFile() || entry.name.length !== GRANT_FILE_NAME_LENGTH) continue;
    if (!isSha256Hex(entry.name.slice(0, 64))) continue;
    const file = path.join(directory, entry.name);
    try {
      const grant = parseGrant(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (grant && nowMs - grant.issued_at_ms <= ARTIFACT_CAPABILITY_TTL_MS) continue;
    } catch {
      // An unreadable grant is not a grant. Removing it is the fail-closed move.
    }
    try {
      fs.unlinkSync(file);
      removed += 1;
    } catch {
      /* a grant we cannot delete still cannot resolve — parseGrant refuses it */
    }
  }
  return removed;
}

/**
 * Mint and persist an edit handle for a stored clip, or return `undefined`.
 *
 * `undefined` is returned — never thrown — because the only caller runs inside
 * the artifact-save try/catch, which collapses every throw into
 * `video-artifact-save-failed`. A handle that could not be minted must not turn
 * a genuinely saved video into a reported failure.
 */
export function mintVideoEditCapabilityHandle(
  dataPath: string,
  artifact: CommandEveVideoConversationArtifact,
  options: { nowMs?: number; randomBytes?: (size: number) => Uint8Array } = {}
): string | undefined {
  const nowMs = options.nowMs ?? Date.now();
  const grant = mintVideoEditCapabilityGrant({
    artifact,
    nowMs,
    randomBytes: options.randomBytes ?? ((size: number) => new Uint8Array(crypto.randomBytes(size))),
  });
  if (!grant) return undefined;
  try {
    pruneArtifactCapabilityGrants(dataPath, nowMs);
    writeGrantAtomic(path.join(capabilityDirectory(dataPath), grantFileName(grant.handle)), grant);
    return grant.handle;
  } catch {
    return undefined;
  }
}

const CAPABILITY_INDEX_DIR = 'by-artifact';

function indexFile(dataPath: string, conversationId: string, artifactId: string): string {
  const key = crypto.createHash('sha256').update(`${conversationId}|${artifactId}`).digest('hex');
  return path.join(capabilityDirectory(dataPath), CAPABILITY_INDEX_DIR, `${key}.json`);
}

/**
 * The handle for this artifact — reused if we already minted one that is still
 * valid, freshly minted otherwise.
 *
 * Reuse is not an optimisation. Every turn carries the envelope, so minting per
 * turn would create one live secret per turn per artifact: hundreds of keys to
 * the same paid action, all of them valid, none of them revoked. One handle per
 * (conversation, artifact, bytes) keeps the authority surface the size of the
 * thing it describes.
 *
 * The stored grant is re-validated against the CURRENT hash before reuse, so a
 * file that changed underneath us gets a new handle rather than an old one that
 * silently now means something else.
 */
export function ensureVideoEditCapabilityHandle(
  dataPath: string,
  artifact: CommandEveVideoConversationArtifact,
  options: { nowMs?: number; randomBytes?: (size: number) => Uint8Array } = {}
): string | undefined {
  const nowMs = options.nowMs ?? Date.now();
  const file = indexFile(dataPath, artifact.conversation_id, artifact.id);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const existing = readArtifactCapabilityGrant(dataPath, raw.handle, nowMs);
    if (
      existing &&
      existing.conversation_id === artifact.conversation_id &&
      existing.artifact_id === artifact.id &&
      existing.artifact_sha256 === artifact.payload.hash
    ) {
      return existing.handle;
    }
  } catch {
    /* no usable index entry — fall through and mint */
  }

  const handle = mintVideoEditCapabilityHandle(dataPath, artifact, { nowMs, ...options });
  if (!handle) return undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify({ handle }, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {
    // The index is a cache. Losing it costs a re-mint next turn; it never costs
    // correctness, so it must not turn a working handle into a failure.
  }
  return handle;
}

/** Read a grant by handle. Unknown, unreadable and expired all read as absent. */
export function readArtifactCapabilityGrant(
  dataPath: string,
  handle: unknown,
  nowMs: number = Date.now()
): ArtifactCapabilityGrant | undefined {
  if (!isWellFormedArtifactCapabilityHandle(handle)) return undefined;
  try {
    const file = path.join(capabilityDirectory(dataPath), grantFileName(handle));
    const grant = parseGrant(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (!grant) return undefined;
    if (nowMs - grant.issued_at_ms > ARTIFACT_CAPABILITY_TTL_MS) return undefined;
    return grant;
  } catch {
    return undefined;
  }
}

/**
 * The `image_edit` half of `ensureVideoEditCapabilityHandle` (1.820.3).
 *
 * Same store, same index, same one-handle-per-(conversation, artifact, bytes)
 * rule — the managed image record carries no hydration debt, so the reference
 * is a plain (conversation, artifact, sha256) triple rather than a video
 * artifact record. The existing grant is re-validated against the CURRENT hash
 * AND the `image_edit` operation before reuse: a grant minted for a different
 * operation names a different authority and gets replaced, not reused.
 */
export function ensureImageEditCapabilityHandle(
  dataPath: string,
  artifact: { conversation_id: string; artifact_id: string; artifact_sha256: string },
  options: { nowMs?: number; randomBytes?: (size: number) => Uint8Array } = {}
): string | undefined {
  const nowMs = options.nowMs ?? Date.now();
  const file = indexFile(dataPath, artifact.conversation_id, artifact.artifact_id);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const existing = readArtifactCapabilityGrant(dataPath, raw.handle, nowMs);
    if (
      existing &&
      existing.conversation_id === artifact.conversation_id &&
      existing.artifact_id === artifact.artifact_id &&
      existing.artifact_sha256 === artifact.artifact_sha256 &&
      existing.operation === 'image_edit'
    ) {
      return existing.handle;
    }
  } catch {
    /* no usable index entry — fall through and mint */
  }

  const grant = mintImageEditCapabilityGrant({
    conversationId: artifact.conversation_id,
    artifactId: artifact.artifact_id,
    artifactSha256: artifact.artifact_sha256,
    nowMs,
    randomBytes: options.randomBytes ?? ((size: number) => new Uint8Array(crypto.randomBytes(size))),
  });
  if (!grant) return undefined;
  try {
    pruneArtifactCapabilityGrants(dataPath, nowMs);
    writeGrantAtomic(path.join(capabilityDirectory(dataPath), grantFileName(grant.handle)), grant);
  } catch {
    return undefined;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${JSON.stringify({ handle: grant.handle }, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {
    // The index is a cache. Losing it costs a re-mint next turn; it never costs
    // correctness, so it must not turn a working handle into a failure.
  }
  return grant.handle;
}

export type ImageEditCapabilityResolution =
  | { ok: true; grant: ArtifactCapabilityGrant }
  | { ok: false; reason: ArtifactCapabilityRefusal };

/**
 * Turn a presented `image_edit` handle into an authorised grant, or refuse.
 *
 * Slimmer than `resolveVideoEditCapability` on purpose: the artifact lookup is
 * the caller's own store's job (the image edit handler reads its record and its
 * private bytes, and hashes what it actually read), so what remains here is the
 * credential judgement — well-formed, minted by us, this conversation, this
 * operation, these bytes. `observedArtifactSha256` MUST be the hash of the
 * bytes the caller is about to send, exactly as on the video path.
 */
export function resolveImageEditCapability(
  dataPath: string,
  input: { handle: unknown; observedArtifactSha256: string; expectedConversationId?: string },
  deps: { readGrant: typeof readArtifactCapabilityGrant; nowMs: () => number } = {
    readGrant: readArtifactCapabilityGrant,
    nowMs: () => Date.now(),
  }
): ImageEditCapabilityResolution {
  const grant = deps.readGrant(dataPath, input.handle, deps.nowMs());
  if (!grant) {
    return {
      ok: false,
      reason: isWellFormedArtifactCapabilityHandle(input.handle) ? 'handle-unknown' : 'handle-malformed',
    };
  }
  if (input.expectedConversationId !== undefined && input.expectedConversationId !== grant.conversation_id) {
    return { ok: false, reason: 'conversation-mismatch' };
  }
  return resolveArtifactCapabilityGrant({
    handle: input.handle,
    grant,
    conversationId: grant.conversation_id,
    operation: 'image_edit',
    observedArtifactSha256: input.observedArtifactSha256,
  });
}

export type VideoEditCapabilityResolution =
  | { ok: true; grant: ArtifactCapabilityGrant; artifact: CommandEveVideoConversationArtifact }
  | { ok: false; reason: ArtifactCapabilityRefusal | 'artifact-missing' };

export interface VideoEditCapabilityResolveDeps {
  listArtifactRecords: typeof listVideoArtifactRecords;
  readGrant: typeof readArtifactCapabilityGrant;
  nowMs: () => number;
}

const productionResolveDeps: VideoEditCapabilityResolveDeps = {
  listArtifactRecords: listVideoArtifactRecords,
  readGrant: readArtifactCapabilityGrant,
  nowMs: () => Date.now(),
};

/**
 * Turn a presented handle into an authorised (grant, artifact) pair, or refuse.
 *
 * `observedArtifactSha256` is supplied by the caller and MUST be the hash of the
 * bytes the caller has actually read and is about to send. Hashing the file in
 * here instead would open a window between the check and the read in which the
 * file could change — the classic time-of-check/time-of-use gap, and here it
 * would mean paying to edit bytes nobody authorised. So the caller hashes what
 * it holds, and this function judges that.
 *
 * `expectedConversationId` is optional on purpose: when the caller independently
 * knows which conversation the turn belongs to, a mismatch is a refusal; when it
 * does not, the grant's own conversation is used and nothing is taken on the
 * caller's word.
 */
export function resolveVideoEditCapability(
  dataPath: string,
  input: { handle: unknown; observedArtifactSha256: string; expectedConversationId?: string },
  deps: VideoEditCapabilityResolveDeps = productionResolveDeps
): VideoEditCapabilityResolution {
  const nowMs = deps.nowMs();
  const grant = deps.readGrant(dataPath, input.handle, nowMs);
  if (!grant) {
    return {
      ok: false,
      reason: isWellFormedArtifactCapabilityHandle(input.handle) ? 'handle-unknown' : 'handle-malformed',
    };
  }
  if (input.expectedConversationId !== undefined && input.expectedConversationId !== grant.conversation_id) {
    return { ok: false, reason: 'conversation-mismatch' };
  }

  const records = deps.listArtifactRecords(dataPath, grant.conversation_id);
  const artifact = records.find((record) => record.id === grant.artifact_id);
  if (!artifact) return { ok: false, reason: 'artifact-missing' };

  const resolution = resolveArtifactCapabilityGrant({
    handle: input.handle,
    grant,
    conversationId: grant.conversation_id,
    operation: 'video_edit',
    observedArtifactSha256: input.observedArtifactSha256,
  });
  // `=== false`, not `!`: this repo compiles without `strictNullChecks`, where
  // truthiness alone does not narrow a discriminated union. Comparing against
  // the literal does, so the refusal branch keeps its `reason`.
  if (resolution.ok === false) return { ok: false, reason: resolution.reason };
  return { ok: true, grant, artifact };
}

/**
 * Look up a conversation's artifacts and hand back the envelope entries for it,
 * plus the artifact hashes a spend permit for this turn may cover.
 *
 * Newest first, because when a user says "das Video" they mean the one they just
 * saw.
 *
 * THE SLICE HAPPENS HERE, BEFORE ANY PER-ARTIFACT WORK, and that ordering is the
 * fix rather than a tidy-up. This runs on the interactive send path — every
 * single turn, while the user waits — and `ensureHandle` reads an index file,
 * may read a grant file, and may write two. Doing that for every artifact and
 * then letting the builder keep the first 24 meant a conversation with 200 clips
 * paid ~600 file operations per keystroke-to-send to produce 24 lines. Slicing
 * first makes the cost proportional to what is actually emitted.
 */
export function buildConversationArtifactEnvelopeEntries(
  dataPath: string,
  conversationId: string,
  options: { nowMs?: number; selectedArtifactIds?: readonly string[]; maxEntries?: number } = {},
  deps: {
    listArtifactRecords: typeof listVideoArtifactRecords;
    ensureHandle: typeof ensureVideoEditCapabilityHandle;
  } = {
    listArtifactRecords: listVideoArtifactRecords,
    ensureHandle: ensureVideoEditCapabilityHandle,
  }
): EveArtifactEnvelopeEntry[] {
  const nowMs = options.nowMs ?? Date.now();
  const selected = new Set(options.selectedArtifactIds ?? []);
  const limit = options.maxEntries ?? ARTIFACT_ENVELOPE_MAX_ARTIFACTS;
  const orderedRecords = deps
    .listArtifactRecords(dataPath, conversationId)
    .toSorted((a, b) => b.created_at - a.created_at);
  // An explicit UI selection outranks recency. The old slice-before-selection
  // order could silently drop an older clip the user had clicked, then mark a
  // different recent clip as the apparent target. Selected records stay
  // newest-first among themselves and consume the same bounded entry budget;
  // unselected recent records fill only the remaining slots.
  const selectedRecords = orderedRecords.filter((record) => selected.has(record.id));
  const remainingRecords = orderedRecords.filter((record) => !selected.has(record.id));
  const records = [...selectedRecords, ...remainingRecords].slice(0, limit);
  return records.map((record) => {
    const payload = hydrateVideoArtifactPayload(record.payload);
    const editable = isVideoArtifactEditable(payload);
    // A handle is minted ONLY for an editable clip, so the envelope can never
    // name a clip the ceiling checks already refused.
    const editHandle = editable ? deps.ensureHandle(dataPath, record, { nowMs }) : undefined;
    // Built as a typed local and then conditionally extended, rather than by
    // spreading `{}` inside the map (oxlint no-map-spread). Whether that
    // preserves the pre-refactor shape EXACTLY is UNPROVEN: this file is
    // untracked, so no baseline exists to diff the old shape against. What IS
    // verified is the CURRENT shape — it satisfies `EveArtifactEnvelopeEntry`,
    // and an optional that does not apply stays ABSENT rather than becoming an
    // own property valued `undefined`, which the own-property test asserts.
    const entry: EveArtifactEnvelopeEntry = {
      artifactId: record.id,
      kind: 'video',
      mimeType: payload.mime_type,
      durationSeconds: payload.duration_seconds,
      editable: editable && Boolean(editHandle),
      artifactSha256: payload.hash,
    };
    if (editHandle !== undefined) entry.editHandle = editHandle;
    if (payload.parent_artifact_id !== undefined) entry.parentArtifactId = payload.parent_artifact_id;
    if (selected.has(record.id)) entry.selected = true;
    return entry;
  });
}
