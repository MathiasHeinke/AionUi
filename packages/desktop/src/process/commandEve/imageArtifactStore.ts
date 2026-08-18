/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.820.3 — local, desktop-owned durability for MANAGED GENERATED images.
 *
 * Same manifest discipline as `videoArtifactStore.ts` — one JSON record per
 * artifact under a private app data directory, written atomically 0600 — with
 * two deliberate differences, both forced by the staged-handle contract:
 *
 *   - records are FLAT, not per-conversation. A staged record has no
 *     conversation yet (generation is agent-mediated; Main cannot attribute the
 *     turn), and the bind must flip `staged` -> `active` IN PLACE rather than
 *     move a file between directories — a move is a second thing that can
 *     half-fail, and the record's own fields already say everything a directory
 *     name would;
 *   - the BYTES live in a private blob file (`blobs/<artifact id>`, 0600) that
 *     only Main reads. The video lane could lean on `~/Downloads` because the
 *     preview bridge already trusted that root; the whole point of this lane is
 *     that NO path ever leaves Main, so the blob stays inside dataPath and the
 *     renderer gets its preview by artifact id over IPC.
 *
 * This is NOT the sent-image registry (`visual/imageArtifactRecordStore.ts`,
 * dir `command-eve-image-artifacts`): that one records images the USER attached
 * and stores no bytes; this one records images the APP generated and is the
 * only reader of their bytes.
 *
 * The staged handle files (`staged/<sha256(handle)>.json`) follow the
 * capability-store doctrine: the filename is the digest of the secret, so a
 * directory listing hands out nothing presentable. A bound handle file is kept
 * until its TTL — not deleted at bind — because the terminal bind can be
 * re-delivered (stream replay, a second `finish`), and the file is what lets
 * the re-delivery resolve to the record and answer "already bound" instead of
 * "unknown".
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSha256Hex } from '@/common/config/eveOpaqueTokenCore';
import { LEGACY_SEAT_ID, sanitizeSeatId } from '@/common/config/seatConfigKeyCore';
import {
  IMAGE_STAGED_HANDLE_TTL_MS,
  isWellFormedImageStagedHandle,
  mintImageStagedHandle,
  parseManagedImageArtifactRecord,
  type CommandEveActiveImageArtifact,
  type CommandEveManagedImageArtifact,
} from '@/common/config/managedImageArtifactCore';
import { ensureImageEditCapabilityHandle } from './artifactCapabilityHandleStore';
import { consumeCommandEveFileSelectionPathGrant } from './fileSelectionGrantCore';
import {
  ensurePrivateDirectory,
  syncDirectoryDurable,
  writeJsonAtomic,
} from '@process/services/project-workspace/storage/atomicJson';
import { writePrivateDocumentImmutable } from './document/privateDocumentCache';
import {
  canonicalArtifactSlug,
  publishCanonicalArtifact,
  verifyCanonicalArtifact,
  type CanonicalArtifactPlacement,
} from '@process/services/project-workspace/storage/canonicalArtifactPlacement';

const MANAGED_IMAGE_ARTIFACT_DIR = 'command-eve-managed-image-artifacts';
const RECORDS_SUBDIR = 'records';
const BLOBS_SUBDIR = 'blobs';
const STAGED_SUBDIR = 'staged';
const LOCATIONS_SUBDIR = 'locations';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Largest image blob this store will read back — mirrors the gateway cap. */
export const MANAGED_IMAGE_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Keep the paid private source for 30 days, then remove it only while the
 * visible canonical file still passes the full descriptor/size/SHA verifier.
 *
 * This bounds the measured heavy-user overhead to about 303–693 MiB/month.
 * Node v24.13.0 does NOT provide APFS clone savings here: its pinned libuv
 * defines FICLONE only for Linux and falls back to sendfile on macOS
 * (`deps/uv/src/unix/fs.c:58-62,1357-1395`), so COPYFILE_FICLONE was measured
 * as a full second copy. Any verification doubt therefore keeps the source.
 */
export const MANAGED_IMAGE_ARTIFACT_RECOVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const EXTENSION_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

const LEGACY_IMPORT_DESCRIPTION = 'Aus der bestehenden Arbeitsdatei importiert';
const TEMPORARY_IMAGE_ARTIFACT_NOTICE =
  'Dieses Bild gehört zu dieser Unterhaltung und ist nur temporär abgelegt. Ordne die Unterhaltung einem Projekt zu, um es dauerhaft im Projektordner zu sichern.';

function storeRoot(dataPath: string): string {
  return path.join(path.resolve(dataPath), MANAGED_IMAGE_ARTIFACT_DIR);
}

function recordFile(dataPath: string, artifactId: string): string {
  return path.join(storeRoot(dataPath), RECORDS_SUBDIR, `${artifactId}.json`);
}

function blobFile(dataPath: string, artifactId: string): string {
  return path.join(storeRoot(dataPath), BLOBS_SUBDIR, artifactId);
}

function locationFile(dataPath: string, artifactId: string): string {
  return path.join(storeRoot(dataPath), LOCATIONS_SUBDIR, `${artifactId}.json`);
}

function readArtifactWorkspace(dataPath: string, artifactId: string): string | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(locationFile(dataPath, artifactId), 'utf8')) as Record<string, unknown>;
    return typeof value.workspace === 'string' && path.isAbsolute(value.workspace) ? value.workspace : undefined;
  } catch {
    return undefined;
  }
}

function stagedHandleFile(dataPath: string, handle: string): string {
  const key = crypto.createHash('sha256').update(handle).digest('hex');
  return path.join(storeRoot(dataPath), STAGED_SUBDIR, `${key}.json`);
}

type StagedHandleEntry = {
  handle: string;
  artifact_id: string;
  seat_id: string;
  issued_at_ms: number;
  expires_at_ms: number;
  /** Set at bind. The file outlives the bind so a re-delivered bind resolves. */
  bound?: boolean;
  conversation_id?: string;
  published_placement?: {
    workspace: string;
    relative_path: string;
    sha256: string;
    size: number;
  };
};

function parseStagedHandleEntry(value: unknown): StagedHandleEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const seatId = Object.prototype.hasOwnProperty.call(record, 'seat_id') ? record.seat_id : LEGACY_SEAT_ID;
  if (
    !isWellFormedImageStagedHandle(record.handle) ||
    typeof record.artifact_id !== 'string' ||
    !SAFE_ID.test(record.artifact_id) ||
    typeof seatId !== 'string' ||
    sanitizeSeatId(seatId) !== seatId ||
    typeof record.issued_at_ms !== 'number' ||
    typeof record.expires_at_ms !== 'number'
  ) {
    return undefined;
  }
  return { ...record, seat_id: seatId } as unknown as StagedHandleEntry;
}

function readStagedHandleFile(file: string): StagedHandleEntry | undefined {
  try {
    return parseStagedHandleEntry(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
  } catch {
    // Unreadable JSON and an unreadable file are the same answer for this
    // store: no staged authority. Never a write — see readManagedImageRecordFile.
    return undefined;
  }
}

function readStagedHandleEntry(dataPath: string, handle: unknown): StagedHandleEntry | undefined {
  if (!isWellFormedImageStagedHandle(handle)) return undefined;
  return readStagedHandleFile(stagedHandleFile(dataPath, handle));
}

function readManagedImageRecordFile(file: string): CommandEveManagedImageArtifact | undefined {
  try {
    return parseManagedImageArtifactRecord(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
  } catch {
    // Same fail-closed answer as the staged reader: absent, never repaired.
    return undefined;
  }
}

function verifyPrivateImageArtifact(
  dataPath: string,
  record: CommandEveManagedImageArtifact
): ReturnType<typeof verifyCanonicalArtifact> {
  return verifyCanonicalArtifact({
    workspaceRoot: storeRoot(dataPath),
    relativePath: path.posix.join(BLOBS_SUBDIR, record.id),
    sha256: record.payload.sha256,
    size: record.payload.size,
  });
}

function readVerifiedPublishedPlacement(
  staged: StagedHandleEntry,
  record: CommandEveManagedImageArtifact,
  workspaceRoot: string
): CanonicalArtifactPlacement | undefined {
  const placement = staged.published_placement;
  if (
    !placement ||
    typeof placement.workspace !== 'string' ||
    !path.isAbsolute(placement.workspace) ||
    path.resolve(placement.workspace) !== path.resolve(workspaceRoot) ||
    typeof placement.relative_path !== 'string' ||
    placement.relative_path.length === 0 ||
    placement.sha256 !== record.payload.sha256 ||
    placement.size !== record.payload.size
  ) {
    return undefined;
  }
  const verified = verifyCanonicalArtifact({
    workspaceRoot,
    relativePath: placement.relative_path,
    sha256: record.payload.sha256,
    size: record.payload.size,
  });
  return verified.ok ? { relativePath: placement.relative_path, absolutePath: verified.absolutePath } : undefined;
}

function removeVerifiedPublishedPlacementFromOtherWorkspace(
  staged: StagedHandleEntry,
  record: CommandEveManagedImageArtifact,
  workspaceRoot: string
): void {
  const placement = staged.published_placement;
  if (
    !placement ||
    typeof placement.workspace !== 'string' ||
    !path.isAbsolute(placement.workspace) ||
    path.resolve(placement.workspace) === path.resolve(workspaceRoot) ||
    typeof placement.relative_path !== 'string' ||
    placement.relative_path.length === 0 ||
    placement.sha256 !== record.payload.sha256 ||
    placement.size !== record.payload.size
  ) {
    return;
  }
  const verified = verifyCanonicalArtifact({
    workspaceRoot: placement.workspace,
    relativePath: placement.relative_path,
    sha256: record.payload.sha256,
    size: record.payload.size,
  });
  // A changed or unverified file is user-owned from this point onwards. Leave
  // it untouched; only EVE's byte-identical pre-commit publication is moved.
  if (verified.ok) fs.unlinkSync(verified.absolutePath);
}

/**
 * Resolve one still-live staged handle back to the record Main minted for it.
 *
 * This is intentionally narrower than a directory scan: recovery already owns
 * the opaque handle from a durable completion receipt, and the handle entry is
 * the only authority allowed to name the staged record. Expired, bound-to-a-
 * different-record, unreadable and missing entries all collapse to absent.
 */
export function readImageArtifactRecordByStagedHandle(
  dataPath: string,
  handle: unknown,
  expectedSeatId: string,
  nowMs: number = Date.now()
): CommandEveManagedImageArtifact | undefined {
  if (sanitizeSeatId(expectedSeatId) !== expectedSeatId) return undefined;
  const staged = readStagedHandleEntry(dataPath, handle);
  if (!staged || staged.seat_id !== expectedSeatId || nowMs > staged.expires_at_ms) return undefined;
  const record = readImageArtifactRecordById(dataPath, staged.artifact_id, expectedSeatId);
  return record?.id === staged.artifact_id && record.seat_id === staged.seat_id ? record : undefined;
}

/** A record by id, or `undefined`. Unreadable and malformed both read as absent. */
export function readImageArtifactRecordById(
  dataPath: string,
  artifactId: string,
  expectedSeatId: string
): CommandEveManagedImageArtifact | undefined {
  if (!SAFE_ID.test(artifactId) || sanitizeSeatId(expectedSeatId) !== expectedSeatId) return undefined;
  const record = readManagedImageRecordFile(recordFile(dataPath, artifactId));
  return record?.seat_id === expectedSeatId ? record : undefined;
}

/**
 * The verified bytes of one artifact, or `undefined`.
 *
 * Active records prefer the visible canonical file. If it was changed, moved
 * or deleted during the retention window, the same descriptor/size/SHA verifier
 * reads the private recovery source instead. A caller still hashes the returned
 * bytes against its capability grant, closing the later check/use boundary.
 */
export function readImageArtifactBytes(
  dataPath: string,
  artifactId: string,
  expectedSeatId: string
): Buffer | undefined {
  try {
    const record = readImageArtifactRecordById(dataPath, artifactId, expectedSeatId);
    if (!record) return undefined;
    if (record.status === 'active') {
      const workspace = readArtifactWorkspace(dataPath, artifactId);
      if (workspace && record.payload.path) {
        const canonical = verifyCanonicalArtifact({
          workspaceRoot: workspace,
          relativePath: record.payload.path,
          sha256: record.payload.sha256,
          size: record.payload.size,
        });
        if (canonical.ok) return canonical.bytes;
      }
    }
    const recovery = verifyPrivateImageArtifact(dataPath, record);
    return recovery.ok ? recovery.bytes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Delete every staged handle past its TTL, together with the record and blob
 * it pointed at while still unbound. Cheap, bounded, never throws upward.
 *
 * A BOUND handle file is removed by TTL too — by then the record is active and
 * the conversation's envelope names a durable capability handle, so the staged
 * reference has done its whole job.
 */
export function purgeExpiredStagedImageArtifacts(dataPath: string, nowMs: number): number {
  const directory = path.join(storeRoot(dataPath), STAGED_SUBDIR);
  let removed = 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    /* a missing staged directory does not suppress recovery-source retention */
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.length !== 69 || !isSha256Hex(entry.name.slice(0, 64))) continue;
    const file = path.join(directory, entry.name);
    let staged: StagedHandleEntry | undefined;
    try {
      staged = readStagedHandleFile(file);
    } catch {
      staged = undefined;
    }
    // An unreadable entry is not an entry; an unexpired one is still live.
    if (staged && nowMs <= staged.expires_at_ms) continue;
    try {
      fs.unlinkSync(file);
      removed += 1;
    } catch {
      /* an undeletable file still cannot resolve — the parser and TTL refuse it */
    }
    if (!staged || staged.bound === true) continue;
    const persisted = readManagedImageRecordFile(recordFile(dataPath, staged.artifact_id));
    if (persisted?.status === 'active') {
      // An active record with an unbound marker is a partial handle-marker
      // commit, not permission to discard its recovery source. The retention
      // scan below applies the same 30-day + verified-canonical rule.
      continue;
    }
    // The record was never bound: it can never become visible now, so its
    // bytes have no remaining purpose. Bound records are left alone — they are
    // active conversation artifacts, not purge candidates.
    try {
      fs.unlinkSync(recordFile(dataPath, staged.artifact_id));
    } catch {
      /* best effort; the record is unreachable without the handle either way */
    }
    try {
      fs.unlinkSync(blobFile(dataPath, staged.artifact_id));
    } catch {
      /* best effort */
    }
  }
  let blobs: fs.Dirent[] = [];
  try {
    blobs = fs.readdirSync(path.join(storeRoot(dataPath), BLOBS_SUBDIR), { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of blobs) {
    if (!entry.isFile() || !SAFE_ID.test(entry.name)) continue;
    try {
      const persisted = readManagedImageRecordFile(recordFile(dataPath, entry.name));
      if (
        !persisted ||
        persisted.status !== 'active' ||
        nowMs < persisted.updated_at + MANAGED_IMAGE_ARTIFACT_RECOVERY_RETENTION_MS ||
        !persisted.payload.path
      ) {
        continue;
      }
      const workspace = readArtifactWorkspace(dataPath, persisted.id);
      if (!workspace) continue;
      const canonical = verifyCanonicalArtifact({
        workspaceRoot: workspace,
        relativePath: persisted.payload.path,
        sha256: persisted.payload.sha256,
        size: persisted.payload.size,
      });
      if (!canonical.ok || !verifyPrivateImageArtifact(dataPath, persisted).ok) continue;
      fs.unlinkSync(blobFile(dataPath, persisted.id));
      syncDirectoryDurable(path.join(storeRoot(dataPath), BLOBS_SUBDIR));
    } catch {
      /* recovery bytes survive every unreadable, ambiguous or failed case */
    }
  }
  return removed;
}

/**
 * Cheap pending-staged probe for the reconcile guard (1.820.3): the artifact
 * list runs on every conversation load AND every chat.history.refresh, and a
 * durable reconcile there must NOT fetch a full transcript window when there
 * is provably nothing to bind. Sweeps expired entries first (same path the
 * mint uses), then counts the valid UNBOUND ones — a bound handle file is
 * retained until its TTL purely so a re-delivered bind resolves "already
 * bound", and it must not tax every list for 30 minutes. A missing directory
 * is a clean 0; an unreadable directory answers "unknown" (1) so recovery
 * work is never skipped on a scan error.
 */
export function countPendingStagedImageArtifacts(
  dataPath: string,
  expectedSeatId: string,
  nowMs: number = Date.now()
): number {
  if (sanitizeSeatId(expectedSeatId) !== expectedSeatId) return 0;
  purgeExpiredStagedImageArtifacts(dataPath, nowMs);
  const directory = path.join(storeRoot(dataPath), STAGED_SUBDIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    return error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' ? 0 : 1;
  }
  let pending = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.length !== 69 || !isSha256Hex(entry.name.slice(0, 64))) continue;
    try {
      const staged = readStagedHandleFile(path.join(directory, entry.name));
      if (staged && staged.seat_id === expectedSeatId && staged.bound !== true) pending += 1;
    } catch {
      /* an unreadable entry is not bindable authority — it does not count */
    }
  }
  return pending;
}

export interface StageGeneratedImageArtifactInput {
  capturedSeatId: string;
  bytes: Uint8Array;
  mimeType: string;
  tier: string;
  model: string;
  resolution: string;
  aspectRatio: string;
  promptSha256: string;
  nameHint?: string;
  parentArtifactId?: string;
  nowMs?: number;
  randomBytes?: (size: number) => Uint8Array;
  newArtifactId?: () => string;
}

/**
 * STAGE a verified generated image: persist the bytes privately, write the
 * `staged` record (no conversation), mint the short-lived staged handle.
 *
 * `undefined` on any failure — the caller (the managed generation service)
 * turns that into the named `managed_image_stage_failed` refusal, because the
 * image was genuinely produced and billed upstream and must not be reported as
 * a generation failure.
 */
export function stageGeneratedImageArtifact(
  dataPath: string,
  input: StageGeneratedImageArtifactInput
): { record: CommandEveManagedImageArtifact; handle: string } | undefined {
  if (!input.bytes || input.bytes.length < 8 || input.bytes.length > MANAGED_IMAGE_ARTIFACT_MAX_BYTES) return undefined;
  if (!isSha256Hex(input.promptSha256)) return undefined;
  if (sanitizeSeatId(input.capturedSeatId) !== input.capturedSeatId) return undefined;
  const nowMs = input.nowMs ?? Date.now();
  const randomBytes = input.randomBytes ?? ((size: number) => new Uint8Array(crypto.randomBytes(size)));
  const handle = mintImageStagedHandle({ randomBytes });
  if (!handle) return undefined;
  try {
    // Housekeeping first, like the capability store's mint: expired staged
    // authority is swept on the same path that creates new authority.
    purgeExpiredStagedImageArtifacts(dataPath, nowMs);
    const artifactId = input.newArtifactId?.() ?? `img_${crypto.randomUUID().replace(/-/g, '')}`;
    if (!SAFE_ID.test(artifactId) || fs.existsSync(recordFile(dataPath, artifactId))) return undefined;
    const bytes = Buffer.from(input.bytes);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const record: CommandEveManagedImageArtifact = {
      id: artifactId,
      seat_id: input.capturedSeatId,
      conversation_id: null,
      kind: 'image',
      status: 'staged',
      payload: {
        artifact_type: 'image',
        title: canonicalArtifactSlug(input.nameHint ?? '', 'bild'),
        description: `${input.resolution} · ${input.aspectRatio} · ${input.model}`,
        managed_image: true,
        mime_type: input.mimeType,
        sha256,
        size: bytes.length,
        tier: input.tier,
        model: input.model,
        resolution: input.resolution,
        aspect_ratio: input.aspectRatio,
        prompt_sha256: input.promptSha256,
        ...(input.parentArtifactId === undefined ? {} : { parent_artifact_id: input.parentArtifactId }),
      },
      created_at: nowMs,
      updated_at: nowMs,
    };
    // The bytes must be durable BEFORE the record that names them: a record
    // whose blob was lost in a crash reads as a present artifact with absent
    // bytes, which is exactly the paid-artifact loss this store must not have.
    ensurePrivateDirectory(storeRoot(dataPath));
    writePrivateDocumentImmutable(storeRoot(dataPath), blobFile(dataPath, artifactId), bytes);
    writeJsonAtomic(recordFile(dataPath, artifactId), record);
    writeJsonAtomic(stagedHandleFile(dataPath, handle), {
      handle,
      artifact_id: artifactId,
      seat_id: input.capturedSeatId,
      issued_at_ms: nowMs,
      expires_at_ms: nowMs + IMAGE_STAGED_HANDLE_TTL_MS,
    } satisfies StagedHandleEntry);
    return { record, handle };
  } catch {
    return undefined;
  }
}

export type ImageArtifactBindResult =
  | { ok: true; record: CommandEveActiveImageArtifact; alreadyBound: boolean }
  | {
      ok: false;
      reason: 'artifact-placement-collision-limit' | 'artifact-placement-no-space';
      message: string;
    }
  | {
      ok: false;
      reason:
        | 'handle-malformed'
        | 'handle-unknown'
        | 'handle-expired'
        | 'artifact-missing'
        | 'seat-mismatch'
        | 'conversation-mismatch'
        | 'parent-mismatch';
    };

export interface ImageArtifactBindDeps {
  /**
   * Mints the durable `image_edit` capability grant at bind. Injected for
   * tests; a mint failure never fails the bind — the next envelope re-mints,
   * exactly like the video lane's own try/catch doctrine.
   */
  ensureEditHandle?: typeof ensureImageEditCapabilityHandle;
}

/**
 * BIND a staged image to its conversation — the display-authority half of the
 * contract, deliberately separate from spend authority.
 *
 * Idempotent by construction: the same tool call re-seen (stream replay, a
 * duplicated `finish`) resolves through the kept handle file to the already
 * active record and answers `alreadyBound` — one artifact, no replay. The same
 * handle presented for a DIFFERENT conversation is refused: a staged image
 * belongs to the first conversation that binds it, and a second claim is a
 * mismatch, not a re-home.
 */
export function bindStagedImageArtifact(
  dataPath: string,
  input: {
    conversationId: string;
    handle: unknown;
    toolCallId: string;
    expectedSeatId: string;
    workspaceRoot?: string;
    nowMs?: number;
  },
  deps: ImageArtifactBindDeps = {}
): ImageArtifactBindResult {
  if (!isWellFormedImageStagedHandle(input.handle)) return { ok: false, reason: 'handle-malformed' };
  const handle = input.handle;
  if (typeof input.conversationId !== 'string' || !SAFE_ID.test(input.conversationId)) {
    return { ok: false, reason: 'handle-malformed' };
  }
  if (typeof input.toolCallId !== 'string' || input.toolCallId.length === 0) {
    return { ok: false, reason: 'handle-malformed' };
  }
  if (sanitizeSeatId(input.expectedSeatId) !== input.expectedSeatId) {
    return { ok: false, reason: 'seat-mismatch' };
  }
  const nowMs = input.nowMs ?? Date.now();
  const staged = readStagedHandleEntry(dataPath, handle);
  if (!staged) return { ok: false, reason: 'handle-unknown' };
  if (staged.seat_id !== input.expectedSeatId) return { ok: false, reason: 'seat-mismatch' };
  if (nowMs > staged.expires_at_ms) return { ok: false, reason: 'handle-expired' };
  const record = readImageArtifactRecordById(dataPath, staged.artifact_id, input.expectedSeatId);
  if (!record) return { ok: false, reason: 'artifact-missing' };

  if (record.status === 'active') {
    if (record.conversation_id !== input.conversationId) return { ok: false, reason: 'conversation-mismatch' };
    try {
      writeJsonAtomic(stagedHandleFile(dataPath, handle), {
        ...staged,
        bound: true,
        conversation_id: input.conversationId,
      } satisfies StagedHandleEntry);
    } catch {
      /* the active record remains authoritative; a later retry can repair the handle marker */
    }
    return { ok: true, record: record as CommandEveActiveImageArtifact, alreadyBound: true };
  }

  if (record.payload.parent_artifact_id !== undefined) {
    const parent = readImageArtifactRecordById(dataPath, record.payload.parent_artifact_id, input.expectedSeatId);
    if (!parent || parent.status !== 'active' || parent.conversation_id !== input.conversationId) {
      return { ok: false, reason: 'parent-mismatch' };
    }
  }

  const temporaryWorkspace = input.workspaceRoot === undefined;
  const workspaceRoot =
    typeof input.workspaceRoot === 'string' && path.isAbsolute(input.workspaceRoot)
      ? input.workspaceRoot
      : path.join(path.resolve(dataPath), 'command-eve-temp-artifacts', input.conversationId);
  if (temporaryWorkspace) fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  const stagedBytes = readImageArtifactBytes(dataPath, record.id, input.expectedSeatId);
  if (
    !stagedBytes ||
    stagedBytes.length !== record.payload.size ||
    crypto.createHash('sha256').update(stagedBytes).digest('hex') !== record.payload.sha256
  ) {
    return { ok: false, reason: 'artifact-missing' };
  }
  let placement = readVerifiedPublishedPlacement(staged, record, workspaceRoot);
  try {
    if (!placement) {
      removeVerifiedPublishedPlacementFromOtherWorkspace(staged, record, workspaceRoot);
      placement = publishCanonicalArtifact({
        dataPath,
        workspaceRoot,
        folder: 'bilder',
        nameHint: record.payload.title,
        fallbackName: 'bild',
        extension: MIME_TO_EXTENSION[record.payload.mime_type] ?? 'png',
        nowMs,
        bytes: stagedBytes,
        beforePublish: (destination) => {
          writeJsonAtomic(stagedHandleFile(dataPath, handle), {
            ...staged,
            published_placement: {
              workspace: workspaceRoot,
              relative_path: destination.relativePath,
              sha256: record.payload.sha256,
              size: record.payload.size,
            },
          } satisfies StagedHandleEntry);
        },
      });
    }
    writeJsonAtomic(locationFile(dataPath, record.id), { workspace: workspaceRoot });
  } catch (error) {
    if (error instanceof Error && error.message === 'EVE_ARTIFACT_COLLISION_LIMIT') {
      return {
        ok: false,
        reason: 'artifact-placement-collision-limit',
        message:
          'Das Bild ist sicher gespeichert, aber dieser Dateiname ist im Projektordner zu oft vergeben. Wähle einen anderen Namen.',
      };
    }
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOSPC') {
      return {
        ok: false,
        reason: 'artifact-placement-no-space',
        message:
          'Das Bild ist sicher gespeichert, aber auf dem Laufwerk ist kein Speicherplatz für die Projektkopie frei. Schaffe Speicherplatz und versuche es dann erneut.',
      };
    }
    return { ok: false, reason: 'artifact-missing' };
  }
  const bound: CommandEveActiveImageArtifact = {
    ...record,
    conversation_id: input.conversationId,
    status: 'active',
    bound_tool_call_id: input.toolCallId,
    payload: {
      ...record.payload,
      path: placement.relativePath,
      ...(() => {
        const cleanupNotice = [
          placement.cleanupNotice,
          ...(temporaryWorkspace ? [TEMPORARY_IMAGE_ARTIFACT_NOTICE] : []),
        ]
          .filter((notice): notice is string => typeof notice === 'string' && notice.length > 0)
          .join(' ');
        return cleanupNotice.length > 0 ? { cleanup_notice: cleanupNotice } : {};
      })(),
    },
    updated_at: nowMs,
  };
  try {
    writeJsonAtomic(recordFile(dataPath, record.id), bound);
    writeJsonAtomic(stagedHandleFile(dataPath, handle), {
      ...staged,
      bound: true,
      conversation_id: input.conversationId,
    } satisfies StagedHandleEntry);
  } catch {
    return { ok: false, reason: 'artifact-missing' };
  }
  // Its OWN try/catch, mirroring the video lane: a handle that could not be
  // minted must not turn a genuinely bound image into a reported failure. The
  // next envelope re-mints it.
  try {
    (deps.ensureEditHandle ?? ensureImageEditCapabilityHandle)(
      dataPath,
      {
        conversation_id: input.conversationId,
        artifact_id: bound.id,
        artifact_sha256: bound.payload.sha256,
        seat_id: input.expectedSeatId,
      },
      { nowMs }
    );
  } catch {
    /* bound and displayable; only the edit affordance is deferred */
  }
  return { ok: true, record: bound, alreadyBound: false };
}

/** Every ACTIVE managed image for this conversation, oldest first. */
export function listActiveImageArtifacts(
  dataPath: string,
  conversationId: string,
  expectedSeatId: string
): CommandEveActiveImageArtifact[] {
  if (!SAFE_ID.test(conversationId) || sanitizeSeatId(expectedSeatId) !== expectedSeatId) return [];
  const directory = path.join(storeRoot(dataPath), RECORDS_SUBDIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const records: CommandEveActiveImageArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const record = readManagedImageRecordFile(path.join(directory, entry.name));
      if (
        record &&
        record.seat_id === expectedSeatId &&
        record.status === 'active' &&
        record.conversation_id === conversationId
      ) {
        records.push(record as CommandEveActiveImageArtifact);
      }
    } catch {
      /* a record that does not parse is not a record */
    }
  }
  return records.toSorted((a, b) => a.created_at - b.created_at);
}

export type ImageArtifactImportResult =
  | { ok: true; record: CommandEveActiveImageArtifact; alreadyImported: boolean }
  | {
      ok: false;
      reason:
        | 'invalid-request'
        | 'workspace-id-mismatch'
        | 'path-outside-workspace'
        | 'file-missing'
        | 'file-unreadable'
        | 'unsupported-file'
        | 'file-selection-required';
    };

/**
 * LEGACY IMPORT (1.820.3, bounded): adopt ONE pre-contract workspace image —
 * the P1 proof file that was saved before this lane existed — as an ACTIVE
 * record bound to the CANONICAL conversation. Pre-Seat bytes have no durable
 * owner proof, so only the exact legacy owner `seat-1` may adopt them.
 *
 * TWO identifiers, kept deliberately distinct (the wrong-scoping defect this
 * fixes): `conversationId` is the CANONICAL conversation the record belongs to
 * and is listed under; `legacyWorkspaceId` is the Hermes WORKSPACE FOLDER the
 * pre-contract lane saved into. The UI surfaces the canonical id, so a record
 * bound to the folder id would persist but never render — exactly the failure
 * the first import produced. The only accepted relationship between the two is
 * the Hermes legacy folder shape itself:
 *
 *   legacyWorkspaceId === 'hermes-temp-' + conversationId     (exactly)
 *
 * Anything else is refused — no arbitrary path acceptance, no id mapping
 * table, no heuristic.
 *
 * The confinement check is the rest of the function: the file is accepted only
 * when its REALPATH is exactly the expected file inside the legacy workspace
 * root — `..`, a subdirectory, an absolute path or a symlink all resolve to
 * something else and are refused. No path is stored anywhere: the payload
 * keeps sha, size and mime only, like every other record in this store.
 */
export function importLegacyImageArtifact(
  dataPath: string,
  input: {
    conversationId: string;
    legacyWorkspaceId: string;
    expectedFileName: string;
    workspaceRoot: string;
    capturedSeatId: string;
    nowMs?: number;
  },
  deps: ImageArtifactBindDeps = {}
): ImageArtifactImportResult {
  const { conversationId, legacyWorkspaceId, expectedFileName, workspaceRoot } = input;
  if (
    typeof conversationId !== 'string' ||
    !SAFE_ID.test(conversationId) ||
    typeof legacyWorkspaceId !== 'string' ||
    !SAFE_ID.test(legacyWorkspaceId) ||
    typeof expectedFileName !== 'string' ||
    !SAFE_FILE_NAME.test(expectedFileName) ||
    expectedFileName === '..' ||
    typeof workspaceRoot !== 'string' ||
    workspaceRoot.length === 0 ||
    sanitizeSeatId(input.capturedSeatId) !== input.capturedSeatId ||
    input.capturedSeatId !== LEGACY_SEAT_ID
  ) {
    return { ok: false, reason: 'invalid-request' };
  }
  // THE non-path fence: the legacy folder must be exactly the Hermes shape for
  // THIS canonical conversation, or the import is not the bounded migration it
  // claims to be.
  if (legacyWorkspaceId !== `hermes-temp-${conversationId}`) return { ok: false, reason: 'workspace-id-mismatch' };
  const mimeType = EXTENSION_TO_MIME[path.extname(expectedFileName).toLowerCase()];
  if (!mimeType) return { ok: false, reason: 'unsupported-file' };

  // `path.resolve` collapses `..` segments, so a traversal name lands OUTSIDE
  // the root and the dirname comparison refuses it. An absolute file name
  // ignores the root entirely and fails the same check.
  const rootResolved = path.resolve(workspaceRoot);
  const candidate = path.resolve(rootResolved, expectedFileName);
  if (path.dirname(candidate) !== rootResolved) return { ok: false, reason: 'path-outside-workspace' };

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(candidate);
  } catch {
    return { ok: false, reason: 'file-missing' };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, reason: 'file-unreadable' };
  if (stat.size <= 0 || stat.size > MANAGED_IMAGE_ARTIFACT_MAX_BYTES) return { ok: false, reason: 'file-unreadable' };

  // THE strict check: the RESOLVED path must be exactly the expected workspace
  // file — a symlinked parent directory or a hardlink elsewhere resolves
  // somewhere else and is refused.
  try {
    const realRoot = fs.realpathSync(rootResolved);
    const realCandidate = fs.realpathSync(candidate);
    if (realCandidate !== path.join(realRoot, expectedFileName)) {
      return { ok: false, reason: 'path-outside-workspace' };
    }
  } catch {
    return { ok: false, reason: 'file-missing' };
  }

  // A completed legacy import is durable and safe to re-deliver without
  // another selection grant. Keep that retry narrow: only the exact
  // conversation's Main-written legacy record, identified by this fenced
  // workspace filename, qualifies. The path and realpath fences above still
  // run before this shortcut.
  const existing = listActiveImageArtifacts(dataPath, conversationId, input.capturedSeatId).find(
    (record) =>
      record.payload.managed_image === true &&
      record.payload.title === expectedFileName &&
      record.payload.description === LEGACY_IMPORT_DESCRIPTION &&
      record.payload.tier === 'legacy' &&
      record.payload.model === 'legacy'
  );
  if (existing) return { ok: true, record: existing, alreadyImported: true };

  // The workspace name merely confines the renderer-supplied filename; it
  // cannot confer authority to read it. Only Main's live, seat-bound grant for
  // this exact resolved candidate may adopt ownerless pre-seat bytes. Consume
  // it at this boundary so nothing downstream can accidentally reuse it.
  if (
    !consumeCommandEveFileSelectionPathGrant({
      filePath: candidate,
      seatId: input.capturedSeatId,
      purpose: 'read',
    })
  ) {
    return { ok: false, reason: 'file-selection-required' };
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(candidate);
  } catch {
    return { ok: false, reason: 'file-unreadable' };
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const nowMs = input.nowMs ?? Date.now();

  try {
    const artifactId = `img_${crypto.randomUUID().replace(/-/g, '')}`;
    const record: CommandEveActiveImageArtifact = {
      id: artifactId,
      seat_id: input.capturedSeatId,
      conversation_id: conversationId,
      kind: 'image',
      status: 'active',
      payload: {
        artifact_type: 'image',
        title: expectedFileName,
        description: LEGACY_IMPORT_DESCRIPTION,
        managed_image: true,
        mime_type: mimeType,
        sha256,
        size: bytes.length,
        tier: 'legacy',
        model: 'legacy',
        resolution: 'unknown',
        aspect_ratio: 'unknown',
        // The prompt that produced the legacy file is unrecoverable; the empty
        // digest says "unknown" rather than inventing one.
        prompt_sha256: crypto.createHash('sha256').update('').digest('hex'),
      },
      created_at: stat.mtimeMs > 0 ? Math.round(stat.mtimeMs) : nowMs,
      updated_at: nowMs,
    };
    ensurePrivateDirectory(storeRoot(dataPath));
    writePrivateDocumentImmutable(storeRoot(dataPath), blobFile(dataPath, artifactId), bytes);
    writeJsonAtomic(recordFile(dataPath, artifactId), record);
    try {
      (deps.ensureEditHandle ?? ensureImageEditCapabilityHandle)(
        dataPath,
        {
          conversation_id: conversationId,
          artifact_id: artifactId,
          artifact_sha256: sha256,
          seat_id: input.capturedSeatId,
        },
        { nowMs }
      );
    } catch {
      /* imported and displayable; the edit affordance re-mints on the next envelope */
    }
    return { ok: true, record, alreadyImported: false };
  } catch {
    return { ok: false, reason: 'file-unreadable' };
  }
}
