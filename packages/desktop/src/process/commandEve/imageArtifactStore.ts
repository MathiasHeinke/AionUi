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
import {
  IMAGE_STAGED_HANDLE_TTL_MS,
  isWellFormedImageStagedHandle,
  mintImageStagedHandle,
  parseManagedImageArtifactRecord,
  type CommandEveActiveImageArtifact,
  type CommandEveManagedImageArtifact,
} from '@/common/config/managedImageArtifactCore';
import { ensureImageEditCapabilityHandle } from './artifactCapabilityHandleStore';

const MANAGED_IMAGE_ARTIFACT_DIR = 'command-eve-managed-image-artifacts';
const RECORDS_SUBDIR = 'records';
const BLOBS_SUBDIR = 'blobs';
const STAGED_SUBDIR = 'staged';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Largest image blob this store will read back — mirrors the gateway cap. */
export const MANAGED_IMAGE_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;

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

function storeRoot(dataPath: string): string {
  return path.join(path.resolve(dataPath), MANAGED_IMAGE_ARTIFACT_DIR);
}

function recordFile(dataPath: string, artifactId: string): string {
  return path.join(storeRoot(dataPath), RECORDS_SUBDIR, `${artifactId}.json`);
}

function blobFile(dataPath: string, artifactId: string): string {
  return path.join(storeRoot(dataPath), BLOBS_SUBDIR, artifactId);
}

function stagedHandleFile(dataPath: string, handle: string): string {
  const key = crypto.createHash('sha256').update(handle).digest('hex');
  return path.join(storeRoot(dataPath), STAGED_SUBDIR, `${key}.json`);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeJsonAtomic(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tempFile = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tempFile, 0o600);
  fs.renameSync(tempFile, file);
}

type StagedHandleEntry = {
  handle: string;
  artifact_id: string;
  issued_at_ms: number;
  expires_at_ms: number;
  /** Set at bind. The file outlives the bind so a re-delivered bind resolves. */
  bound?: boolean;
  conversation_id?: string;
};

function parseStagedHandleEntry(value: unknown): StagedHandleEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !isWellFormedImageStagedHandle(record.handle) ||
    typeof record.artifact_id !== 'string' ||
    !SAFE_ID.test(record.artifact_id) ||
    typeof record.issued_at_ms !== 'number' ||
    typeof record.expires_at_ms !== 'number'
  ) {
    return undefined;
  }
  return record as unknown as StagedHandleEntry;
}

function readStagedHandleEntry(dataPath: string, handle: unknown): StagedHandleEntry | undefined {
  if (!isWellFormedImageStagedHandle(handle)) return undefined;
  try {
    return parseStagedHandleEntry(JSON.parse(fs.readFileSync(stagedHandleFile(dataPath, handle), 'utf8')));
  } catch {
    return undefined;
  }
}

/** A record by id, or `undefined`. Unreadable and malformed both read as absent. */
export function readImageArtifactRecordById(
  dataPath: string,
  artifactId: string
): CommandEveManagedImageArtifact | undefined {
  if (!SAFE_ID.test(artifactId)) return undefined;
  try {
    return parseManagedImageArtifactRecord(JSON.parse(fs.readFileSync(recordFile(dataPath, artifactId), 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * The private bytes of one artifact, or `undefined`.
 *
 * Bounded by lstat BEFORE the read so an oversized blob is never loaded, and
 * symlink-refused: the blob directory is private, but a file that is not a
 * plain file is not something this lane wrote. The SHA-256 check against the
 * record is the CALLER's job — the edit handler hashes what it actually read
 * and judges the capability grant against that, closing the check/use window.
 */
export function readImageArtifactBytes(dataPath: string, artifactId: string): Buffer | undefined {
  if (!SAFE_ID.test(artifactId)) return undefined;
  try {
    const file = blobFile(dataPath, artifactId);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    if (stat.size <= 0 || stat.size > MANAGED_IMAGE_ARTIFACT_MAX_BYTES) return undefined;
    return fs.readFileSync(file);
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
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.length !== 69 || !isSha256Hex(entry.name.slice(0, 64))) continue;
    const file = path.join(directory, entry.name);
    let staged: StagedHandleEntry | undefined;
    try {
      staged = parseStagedHandleEntry(JSON.parse(fs.readFileSync(file, 'utf8')));
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
export function countPendingStagedImageArtifacts(dataPath: string, nowMs: number = Date.now()): number {
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
      const staged = parseStagedHandleEntry(JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8')));
      if (staged && staged.bound !== true) pending += 1;
    } catch {
      /* an unreadable entry is not bindable authority — it does not count */
    }
  }
  return pending;
}

export interface StageGeneratedImageArtifactInput {
  bytes: Uint8Array;
  mimeType: string;
  tier: string;
  model: string;
  resolution: string;
  aspectRatio: string;
  promptSha256: string;
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
  const nowMs = input.nowMs ?? Date.now();
  const randomBytes = input.randomBytes ?? ((size: number) => new Uint8Array(crypto.randomBytes(size)));
  const handle = mintImageStagedHandle({ randomBytes });
  if (!handle) return undefined;
  try {
    // Housekeeping first, like the capability store's mint: expired staged
    // authority is swept on the same path that creates new authority.
    purgeExpiredStagedImageArtifacts(dataPath, nowMs);
    const artifactId = `img_${crypto.randomUUID().replace(/-/g, '')}`;
    const bytes = Buffer.from(input.bytes);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const record: CommandEveManagedImageArtifact = {
      id: artifactId,
      conversation_id: null,
      kind: 'image',
      status: 'staged',
      payload: {
        artifact_type: 'image',
        title: `Bild ${input.resolution}`,
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
    ensureDir(path.dirname(blobFile(dataPath, artifactId)));
    fs.writeFileSync(blobFile(dataPath, artifactId), bytes, { mode: 0o600 });
    fs.chmodSync(blobFile(dataPath, artifactId), 0o600);
    writeJsonAtomic(recordFile(dataPath, artifactId), record);
    writeJsonAtomic(stagedHandleFile(dataPath, handle), {
      handle,
      artifact_id: artifactId,
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
      reason: 'handle-malformed' | 'handle-unknown' | 'handle-expired' | 'artifact-missing' | 'conversation-mismatch';
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
  input: { conversationId: string; handle: unknown; toolCallId: string; nowMs?: number },
  deps: ImageArtifactBindDeps = {}
): ImageArtifactBindResult {
  if (!isWellFormedImageStagedHandle(input.handle)) return { ok: false, reason: 'handle-malformed' };
  if (typeof input.conversationId !== 'string' || !SAFE_ID.test(input.conversationId)) {
    return { ok: false, reason: 'handle-malformed' };
  }
  if (typeof input.toolCallId !== 'string' || input.toolCallId.length === 0) {
    return { ok: false, reason: 'handle-malformed' };
  }
  const nowMs = input.nowMs ?? Date.now();
  const staged = readStagedHandleEntry(dataPath, input.handle);
  if (!staged) return { ok: false, reason: 'handle-unknown' };
  if (nowMs > staged.expires_at_ms) return { ok: false, reason: 'handle-expired' };
  const record = readImageArtifactRecordById(dataPath, staged.artifact_id);
  if (!record) return { ok: false, reason: 'artifact-missing' };

  if (record.status === 'active') {
    if (record.conversation_id !== input.conversationId) return { ok: false, reason: 'conversation-mismatch' };
    return { ok: true, record: record as CommandEveActiveImageArtifact, alreadyBound: true };
  }

  const bound: CommandEveActiveImageArtifact = {
    ...record,
    conversation_id: input.conversationId,
    status: 'active',
    bound_tool_call_id: input.toolCallId,
    updated_at: nowMs,
  };
  try {
    writeJsonAtomic(recordFile(dataPath, record.id), bound);
    writeJsonAtomic(stagedHandleFile(dataPath, input.handle), {
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
      },
      { nowMs }
    );
  } catch {
    /* bound and displayable; only the edit affordance is deferred */
  }
  return { ok: true, record: bound, alreadyBound: false };
}

/** Every ACTIVE managed image for this conversation, oldest first. */
export function listActiveImageArtifacts(dataPath: string, conversationId: string): CommandEveActiveImageArtifact[] {
  if (!SAFE_ID.test(conversationId)) return [];
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
      const record = parseManagedImageArtifactRecord(
        JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8'))
      );
      if (record && record.status === 'active' && record.conversation_id === conversationId) {
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
        | 'unsupported-file';
    };

/**
 * LEGACY IMPORT (1.820.3, bounded): adopt ONE pre-contract workspace image —
 * the P1 proof file that was saved before this lane existed — as an ACTIVE
 * record bound to the CANONICAL conversation.
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
  input: { conversationId: string; legacyWorkspaceId: string; expectedFileName: string; workspaceRoot: string; nowMs?: number },
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
    workspaceRoot.length === 0
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

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(candidate);
  } catch {
    return { ok: false, reason: 'file-unreadable' };
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const nowMs = input.nowMs ?? Date.now();

  // Idempotent: the same file imported twice (a retried migration) yields the
  // existing record, not a second artifact.
  const existing = listActiveImageArtifacts(dataPath, conversationId).find(
    (record) => record.payload.sha256 === sha256
  );
  if (existing) return { ok: true, record: existing, alreadyImported: true };

  try {
    const artifactId = `img_${crypto.randomUUID().replace(/-/g, '')}`;
    const record: CommandEveActiveImageArtifact = {
      id: artifactId,
      conversation_id: conversationId,
      kind: 'image',
      status: 'active',
      payload: {
        artifact_type: 'image',
        title: expectedFileName,
        description: 'Aus der bestehenden Arbeitsdatei importiert',
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
    ensureDir(path.dirname(blobFile(dataPath, artifactId)));
    fs.writeFileSync(blobFile(dataPath, artifactId), bytes, { mode: 0o600 });
    fs.chmodSync(blobFile(dataPath, artifactId), 0o600);
    writeJsonAtomic(recordFile(dataPath, artifactId), record);
    try {
      (deps.ensureEditHandle ?? ensureImageEditCapabilityHandle)(
        dataPath,
        { conversation_id: conversationId, artifact_id: artifactId, artifact_sha256: sha256 },
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
