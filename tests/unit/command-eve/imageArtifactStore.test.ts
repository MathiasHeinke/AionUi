import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bindStagedImageArtifact,
  importLegacyImageArtifact,
  listActiveImageArtifacts,
  purgeExpiredStagedImageArtifacts,
  readImageArtifactBytes,
  readImageArtifactRecordById,
  readImageArtifactRecordByStagedHandle,
  stageGeneratedImageArtifact,
} from '@/process/commandEve/imageArtifactStore';
import { IMAGE_STAGED_HANDLE_TTL_MS } from '@/common/config/managedImageArtifactCore';
import {
  areCommandEveFileSelectionPathsGranted,
  clearCommandEveFileSelectionGrantsForTests,
  registerCommandEveFileSelectionGrant,
} from '@/process/commandEve/fileSelectionGrantCore';

const BYTES = Buffer.from('png-bytes-here');
const PROMPT_SHA = crypto.createHash('sha256').update('a prompt').digest('hex');
const SEAT_A = 'seat-a';
const SEAT_B = 'seat-b';
const LEGACY_SEAT = 'seat-1';

let dataRoot: string;

function stage(
  nowMs = Date.now(),
  capturedSeatId = SEAT_A,
  extra: { parentArtifactId?: string; newArtifactId?: () => string } = {}
) {
  const staged = stageGeneratedImageArtifact(dataRoot, {
    capturedSeatId,
    bytes: BYTES,
    mimeType: 'image/png',
    tier: 'quality',
    model: 'gemini',
    resolution: '1K',
    aspectRatio: '16:9',
    promptSha256: PROMPT_SHA,
    nowMs,
    ...extra,
  });
  expect(staged).toBeTruthy();
  return staged!;
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-image-store-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  clearCommandEveFileSelectionGrantsForTests();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('STAGE', () => {
  it('persists the bytes privately (0600 blob), writes a staged record with NO conversation, and mints a well-formed handle', () => {
    const { record, handle } = stage();
    expect(handle).toMatch(/^img_h_[0-9a-f]{64}$/);
    expect(record.status).toBe('staged');
    expect(record.seat_id).toBe(SEAT_A);
    expect(record.conversation_id).toBeNull();
    expect(record.payload.sha256).toBe(crypto.createHash('sha256').update(BYTES).digest('hex'));
    // No path anywhere in the record — the payload is sha/size/mime only.
    expect(JSON.stringify(record)).not.toContain(dataRoot);
    const blob = path.join(dataRoot, 'command-eve-managed-image-artifacts', 'blobs', record.id);
    expect(fs.readFileSync(blob).equals(BYTES)).toBe(true);
    expect(fs.statSync(blob).mode & 0o777).toBe(0o600);
    expect(readImageArtifactBytes(dataRoot, record.id, SEAT_A)?.equals(BYTES)).toBe(true);
  });

  it('an unbound staged record is listed for NO conversation', () => {
    stage();
    expect(listActiveImageArtifacts(dataRoot, 'conv-1', SEAT_A)).toEqual([]);
  });

  it('fsyncs every persisted record and blob so a crash after rename cannot empty a paid artifact', () => {
    const fsyncedFiles: string[] = [];
    const openPaths = new Map<number, string>();
    const realOpen = fs.openSync;
    const realFsync = fs.fsyncSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
      const descriptor = (realOpen as (...args: unknown[]) => number)(file, ...rest);
      openPaths.set(descriptor, String(file));
      return descriptor;
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor: number) => {
      fsyncedFiles.push(openPaths.get(descriptor) ?? '');
      realFsync(descriptor);
    });

    const { record, handle } = stage();
    const storeRoot = path.join(dataRoot, 'command-eve-managed-image-artifacts');
    const recordFile = path.join(storeRoot, 'records', `${record.id}.json`);
    const blob = path.join(storeRoot, 'blobs', record.id);
    const stagedFile = path.join(
      storeRoot,
      'staged',
      `${crypto.createHash('sha256').update(handle).digest('hex')}.json`
    );

    // Bytes and manifest each reach the platter while still under their temp
    // name, and the directory that publishes the link/rename is fsynced too —
    // otherwise the publish itself can be lost and the artifact reads as absent
    // while its paid bytes are orphaned.
    const fsyncedUnderTempName = (file: string): boolean =>
      fsyncedFiles.some((synced) => path.basename(synced).includes(path.basename(file)));
    expect(fsyncedUnderTempName(blob)).toBe(true);
    expect(fsyncedUnderTempName(recordFile)).toBe(true);
    expect(fsyncedUnderTempName(stagedFile)).toBe(true);
    expect(fsyncedFiles).toContain(path.dirname(blob));
    expect(fsyncedFiles).toContain(path.dirname(recordFile));
    expect(fsyncedFiles).toContain(path.dirname(stagedFile));
  });

  it('leaves no readable record when the blob write fails, so a record never outlives its bytes', () => {
    const realWrite = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: unknown, data: unknown, options?: unknown) => {
      if (typeof file === 'number') throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      return (realWrite as (...args: unknown[]) => void)(file, data, options);
    }) as typeof fs.writeFileSync);

    const staged = stageGeneratedImageArtifact(dataRoot, {
      capturedSeatId: SEAT_A,
      bytes: BYTES,
      mimeType: 'image/png',
      tier: 'quality',
      model: 'gemini',
      resolution: '1K',
      aspectRatio: '16:9',
      promptSha256: PROMPT_SHA,
    });

    expect(staged).toBeUndefined();
    expect(fs.existsSync(path.join(dataRoot, 'command-eve-managed-image-artifacts', 'records'))).toBe(false);
  });
});

describe('LEGACY SEAT RESOLUTION', () => {
  function recordPath(artifactId: string): string {
    return path.join(dataRoot, 'command-eve-managed-image-artifacts', 'records', `${artifactId}.json`);
  }

  function stagedPath(handle: string): string {
    const key = crypto.createHash('sha256').update(handle).digest('hex');
    return path.join(dataRoot, 'command-eve-managed-image-artifacts', 'staged', `${key}.json`);
  }

  function readJson(file: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  }

  it('resolves a seat-less record and staged entry as seat-1 without ever writing on the read path', () => {
    const { record, handle } = stage();
    const recordFile = recordPath(record.id);
    const stagedFile = stagedPath(handle);
    const legacyRecord = readJson(recordFile);
    const legacyStaged = readJson(stagedFile);
    delete legacyRecord.seat_id;
    delete legacyStaged.seat_id;
    fs.writeFileSync(recordFile, `${JSON.stringify(legacyRecord, null, 2)}\n`);
    fs.writeFileSync(stagedFile, `${JSON.stringify(legacyStaged, null, 2)}\n`);
    const recordBytesBefore = fs.readFileSync(recordFile, 'utf8');
    const stagedBytesBefore = fs.readFileSync(stagedFile, 'utf8');
    const recordInodeBefore = fs.statSync(recordFile).ino;
    const stagedInodeBefore = fs.statSync(stagedFile).ino;

    expect(readImageArtifactRecordByStagedHandle(dataRoot, handle, LEGACY_SEAT)?.seat_id).toBe(LEGACY_SEAT);
    expect(readImageArtifactRecordById(dataRoot, record.id, SEAT_A)).toBeUndefined();

    // A paid record must never be rewritten by a reader: the legacy default is
    // applied in memory only, so a crash mid-read can never blank the file.
    expect(fs.readFileSync(recordFile, 'utf8')).toBe(recordBytesBefore);
    expect(fs.readFileSync(stagedFile, 'utf8')).toBe(stagedBytesBefore);
    expect(readJson(recordFile).seat_id).toBeUndefined();
    expect(readJson(stagedFile).seat_id).toBeUndefined();
    expect(fs.statSync(recordFile).ino).toBe(recordInodeBefore);
    expect(fs.statSync(stagedFile).ino).toBe(stagedInodeBefore);
  });

  it.each([null, '', '../seat', 7])('fails closed for an explicit malformed record seat_id: %j', (seatId) => {
    const { record } = stage();
    const file = recordPath(record.id);
    const malformed = { ...readJson(file), seat_id: seatId };
    fs.writeFileSync(file, `${JSON.stringify(malformed, null, 2)}\n`);

    expect(readImageArtifactRecordById(dataRoot, record.id, LEGACY_SEAT)).toBeUndefined();
    expect(readJson(file).seat_id).toEqual(seatId);
  });

  it('fails closed without rewriting an explicitly malformed staged seat_id', () => {
    const { handle } = stage();
    const file = stagedPath(handle);
    const malformed = { ...readJson(file), seat_id: null };
    fs.writeFileSync(file, `${JSON.stringify(malformed, null, 2)}\n`);

    expect(readImageArtifactRecordByStagedHandle(dataRoot, handle, LEGACY_SEAT)).toBeUndefined();
    expect(readJson(file).seat_id).toBeNull();
  });
});

describe('BIND', () => {
  it('flips staged -> active with the conversation, records the tool call id, and mints the durable image_edit grant', () => {
    const { record, handle } = stage();
    const result = bindStagedImageArtifact(dataRoot, {
      conversationId: 'conv-1',
      handle,
      toolCallId: 'call-1',
      expectedSeatId: SEAT_A,
    });
    expect(result).toMatchObject({ ok: true, alreadyBound: false });
    if (result.ok === false) return;
    expect(result.record.status).toBe('active');
    expect(result.record.conversation_id).toBe('conv-1');
    expect(result.record.bound_tool_call_id).toBe('call-1');
    expect(listActiveImageArtifacts(dataRoot, 'conv-1', SEAT_A).map((r) => r.id)).toEqual([record.id]);
    // The durable capability grant exists and binds operation + bytes.
    const grants = fs.readdirSync(path.join(dataRoot, 'command-eve-artifact-capabilities'));
    expect(grants.filter((name) => name.length === 69).length).toBe(1);
  });

  it('a duplicate terminal bind (same toolCallId re-seen) is a no-op: one artifact, no replay', () => {
    const { record, handle } = stage();
    const first = bindStagedImageArtifact(dataRoot, {
      conversationId: 'conv-1',
      handle,
      toolCallId: 'call-1',
      expectedSeatId: SEAT_A,
    });
    const second = bindStagedImageArtifact(dataRoot, {
      conversationId: 'conv-1',
      handle,
      toolCallId: 'call-1',
      expectedSeatId: SEAT_A,
    });
    expect(first).toMatchObject({ ok: true, alreadyBound: false });
    expect(second).toMatchObject({ ok: true, alreadyBound: true });
    expect(listActiveImageArtifacts(dataRoot, 'conv-1', SEAT_A).length).toBe(1);
    expect(readImageArtifactRecordById(dataRoot, record.id, SEAT_A)?.status).toBe('active');
  });

  it('the same handle presented for a DIFFERENT conversation is refused conversation-mismatch', () => {
    const { handle } = stage();
    bindStagedImageArtifact(dataRoot, {
      conversationId: 'conv-1',
      handle,
      toolCallId: 'call-1',
      expectedSeatId: SEAT_A,
    });
    const stolen = bindStagedImageArtifact(dataRoot, {
      conversationId: 'conv-2',
      handle,
      toolCallId: 'call-9',
      expectedSeatId: SEAT_A,
    });
    expect(stolen).toEqual({ ok: false, reason: 'conversation-mismatch' });
    expect(listActiveImageArtifacts(dataRoot, 'conv-2', SEAT_A)).toEqual([]);
  });

  it('malformed, unknown and expired handles are refused; the expired staged record is purged with its bytes', () => {
    const now = 1_754_000_000_000;
    const { record, handle } = stage(now);
    expect(
      bindStagedImageArtifact(dataRoot, {
        conversationId: 'conv-1',
        handle: 'img_h_nope',
        toolCallId: 'c',
        expectedSeatId: SEAT_A,
      })
    ).toEqual({
      ok: false,
      reason: 'handle-malformed',
    });
    expect(
      bindStagedImageArtifact(dataRoot, {
        conversationId: 'conv-1',
        handle: `img_h_${'1'.repeat(64)}`,
        toolCallId: 'c',
        expectedSeatId: SEAT_A,
      })
    ).toEqual({ ok: false, reason: 'handle-unknown' });
    expect(
      bindStagedImageArtifact(dataRoot, {
        conversationId: 'conv-1',
        handle,
        toolCallId: 'c',
        expectedSeatId: SEAT_A,
        nowMs: now + IMAGE_STAGED_HANDLE_TTL_MS + 1,
      })
    ).toEqual({ ok: false, reason: 'handle-expired' });

    const purged = purgeExpiredStagedImageArtifacts(dataRoot, now + IMAGE_STAGED_HANDLE_TTL_MS + 1);
    expect(purged).toBe(1);
    expect(readImageArtifactRecordById(dataRoot, record.id, SEAT_A)).toBeUndefined();
    expect(readImageArtifactBytes(dataRoot, record.id, SEAT_A)).toBeUndefined();
  });

  it('a mint failure of the edit grant never fails the bind itself', () => {
    const { handle } = stage();
    const result = bindStagedImageArtifact(
      dataRoot,
      { conversationId: 'conv-1', handle, toolCallId: 'call-1', expectedSeatId: SEAT_A },
      { ensureEditHandle: () => undefined }
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('refuses every cross-seat surface before bind, read, bytes, or list can expose the staged artifact', () => {
    const { record, handle } = stage();
    expect(readImageArtifactRecordByStagedHandle(dataRoot, handle, SEAT_B)).toBeUndefined();
    expect(readImageArtifactRecordById(dataRoot, record.id, SEAT_B)).toBeUndefined();
    expect(readImageArtifactBytes(dataRoot, record.id, SEAT_B)).toBeUndefined();
    expect(listActiveImageArtifacts(dataRoot, 'conv-1', SEAT_B)).toEqual([]);
    expect(
      bindStagedImageArtifact(dataRoot, {
        conversationId: 'conv-1',
        handle,
        toolCallId: 'call-cross-seat',
        expectedSeatId: SEAT_B,
      })
    ).toEqual({ ok: false, reason: 'seat-mismatch' });
  });

  it('first bind accepts an edit child only with an active parent in the same seat and conversation', () => {
    const parent = stage(Date.now(), SEAT_A, { newArtifactId: () => 'img_parent' });
    expect(
      bindStagedImageArtifact(dataRoot, {
        conversationId: 'conv-1',
        handle: parent.handle,
        toolCallId: 'call-parent',
        expectedSeatId: SEAT_A,
      }).ok
    ).toBe(true);

    const good = stage(Date.now() + 1, SEAT_A, { parentArtifactId: parent.record.id });
    expect(
      bindStagedImageArtifact(dataRoot, {
        conversationId: 'conv-1',
        handle: good.handle,
        toolCallId: 'call-child',
        expectedSeatId: SEAT_A,
      })
    ).toMatchObject({ ok: true, alreadyBound: false });

    const wrongConversation = stage(Date.now() + 2, SEAT_A, { parentArtifactId: parent.record.id });
    expect(
      bindStagedImageArtifact(dataRoot, {
        conversationId: 'conv-2',
        handle: wrongConversation.handle,
        toolCallId: 'call-wrong-conversation',
        expectedSeatId: SEAT_A,
      })
    ).toEqual({ ok: false, reason: 'parent-mismatch' });

    const wrongSeatParent = stage(Date.now() + 3, SEAT_B, { newArtifactId: () => 'img_parent_b' });
    bindStagedImageArtifact(dataRoot, {
      conversationId: 'conv-1',
      handle: wrongSeatParent.handle,
      toolCallId: 'call-parent-b',
      expectedSeatId: SEAT_B,
    });
    const wrongSeatChild = stage(Date.now() + 4, SEAT_A, { parentArtifactId: wrongSeatParent.record.id });
    expect(
      bindStagedImageArtifact(dataRoot, {
        conversationId: 'conv-1',
        handle: wrongSeatChild.handle,
        toolCallId: 'call-wrong-seat',
        expectedSeatId: SEAT_A,
      })
    ).toEqual({ ok: false, reason: 'parent-mismatch' });

    const missingParent = stage(Date.now() + 5, SEAT_A, { parentArtifactId: 'img_missing_parent' });
    expect(
      bindStagedImageArtifact(dataRoot, {
        conversationId: 'conv-1',
        handle: missingParent.handle,
        toolCallId: 'call-missing-parent',
        expectedSeatId: SEAT_A,
      })
    ).toEqual({ ok: false, reason: 'parent-mismatch' });
  });
});

describe('LEGACY IMPORT', () => {
  const FILE_NAME = 'img-1785796180699.png';
  const CANONICAL = '3be29bae';
  const LEGACY_ID = `hermes-temp-${CANONICAL}`;
  let workspaceRoot: string;
  let fileBytes: Buffer;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-legacy-ws-'));
    fileBytes = Buffer.from('legacy-png-bytes');
    fs.writeFileSync(path.join(workspaceRoot, FILE_NAME), fileBytes);
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function grantLegacyFileRead(seatId = LEGACY_SEAT, root = workspaceRoot, fileName = FILE_NAME): void {
    expect(
      registerCommandEveFileSelectionGrant({
        filePath: path.join(root, fileName),
        seatId,
        purpose: 'read',
      })
    ).toBe(true);
  }

  function importExactLegacyFile(capturedSeatId = LEGACY_SEAT) {
    return importLegacyImageArtifact(dataRoot, {
      conversationId: CANONICAL,
      legacyWorkspaceId: LEGACY_ID,
      expectedFileName: FILE_NAME,
      workspaceRoot,
      capturedSeatId,
    });
  }

  it('refuses ownerless legacy bytes without a Main-issued file-selection grant', () => {
    const ensureEditHandle = vi.fn();
    const result = importLegacyImageArtifact(
      dataRoot,
      {
        conversationId: CANONICAL,
        legacyWorkspaceId: LEGACY_ID,
        expectedFileName: FILE_NAME,
        workspaceRoot,
        capturedSeatId: LEGACY_SEAT,
      },
      { ensureEditHandle }
    );

    // Mutation control: removing the store-bound consume check makes this
    // import succeed and creates a durable record.
    expect(result).toEqual({ ok: false, reason: 'file-selection-required' });
    expect(ensureEditHandle).not.toHaveBeenCalled();
    expect(listActiveImageArtifacts(dataRoot, CANONICAL, LEGACY_SEAT)).toEqual([]);
  });

  it('refuses a live grant bound to another seat without consuming it', () => {
    grantLegacyFileRead(SEAT_B);

    expect(importExactLegacyFile()).toEqual({ ok: false, reason: 'file-selection-required' });
    expect(
      areCommandEveFileSelectionPathsGranted({
        filePaths: [path.join(workspaceRoot, FILE_NAME)],
        seatId: SEAT_B,
        purpose: 'read',
      })
    ).toBe(true);
  });

  it('keeps a grant unusable but unconsumed when the candidate is unsupported', () => {
    const unsupportedFile = 'notes.txt';
    fs.writeFileSync(path.join(workspaceRoot, unsupportedFile), 'not an image');
    grantLegacyFileRead(LEGACY_SEAT, workspaceRoot, unsupportedFile);

    expect(
      importLegacyImageArtifact(dataRoot, {
        conversationId: CANONICAL,
        legacyWorkspaceId: LEGACY_ID,
        expectedFileName: unsupportedFile,
        workspaceRoot,
        capturedSeatId: LEGACY_SEAT,
      })
    ).toEqual({ ok: false, reason: 'unsupported-file' });
    expect(
      areCommandEveFileSelectionPathsGranted({
        filePaths: [path.join(workspaceRoot, unsupportedFile)],
        seatId: LEGACY_SEAT,
        purpose: 'read',
      })
    ).toBe(true);
  });

  it('keeps a grant unusable but unconsumed when the candidate is a symlink', () => {
    const symlinkFile = 'img-link.png';
    fs.symlinkSync(path.join(workspaceRoot, FILE_NAME), path.join(workspaceRoot, symlinkFile));
    grantLegacyFileRead(LEGACY_SEAT, workspaceRoot, symlinkFile);

    expect(
      importLegacyImageArtifact(dataRoot, {
        conversationId: CANONICAL,
        legacyWorkspaceId: LEGACY_ID,
        expectedFileName: symlinkFile,
        workspaceRoot,
        capturedSeatId: LEGACY_SEAT,
      })
    ).toEqual({ ok: false, reason: 'file-unreadable' });
    expect(
      areCommandEveFileSelectionPathsGranted({
        filePaths: [path.join(workspaceRoot, symlinkFile)],
        seatId: LEGACY_SEAT,
        purpose: 'read',
      })
    ).toBe(true);
  });

  it('consumes the exact grant before a read failure so it cannot be replayed', () => {
    const candidate = path.join(workspaceRoot, FILE_NAME);
    grantLegacyFileRead();
    const realReadFile = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (file === candidate) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      return (realReadFile as (...args: unknown[]) => Buffer)(file, ...rest);
    }) as typeof fs.readFileSync);

    expect(importExactLegacyFile()).toEqual({ ok: false, reason: 'file-unreadable' });
    expect(
      areCommandEveFileSelectionPathsGranted({
        filePaths: [candidate],
        seatId: LEGACY_SEAT,
        purpose: 'read',
      })
    ).toBe(false);
    expect(listActiveImageArtifacts(dataRoot, CANONICAL, LEGACY_SEAT)).toEqual([]);
  });

  it('adopts the exact granted workspace file for seat-1, consumes the grant once, and retries durably', () => {
    grantLegacyFileRead();
    const result = importExactLegacyFile();
    expect(result).toMatchObject({ ok: true, alreadyImported: false });
    if (result.ok === false) return;
    expect(result.record.status).toBe('active');
    // THE fix: bound to the canonical id, so the canonical artifact surface
    // lists it — and the workspace-folder id lists NOTHING.
    expect(result.record.conversation_id).toBe(CANONICAL);
    expect(result.record.payload.sha256).toBe(crypto.createHash('sha256').update(fileBytes).digest('hex'));
    // No path stored: sha/size/mime only.
    expect(JSON.stringify(result.record)).not.toContain(workspaceRoot);
    expect(listActiveImageArtifacts(dataRoot, CANONICAL, LEGACY_SEAT).length).toBe(1);
    expect(listActiveImageArtifacts(dataRoot, LEGACY_ID, LEGACY_SEAT)).toEqual([]);

    expect(
      areCommandEveFileSelectionPathsGranted({
        filePaths: [path.join(workspaceRoot, FILE_NAME)],
        seatId: LEGACY_SEAT,
        purpose: 'read',
      })
    ).toBe(false);

    const again = importExactLegacyFile();
    expect(again).toMatchObject({ ok: true, alreadyImported: true });
    if (again.ok) expect(again.record.id).toBe(result.record.id);
    expect(listActiveImageArtifacts(dataRoot, CANONICAL, LEGACY_SEAT).length).toBe(1);
  });

  it('refuses Seat B before deterministic legacy bytes can be claimed', () => {
    const ensureEditHandle = vi.fn();
    const result = importLegacyImageArtifact(
      dataRoot,
      {
        conversationId: CANONICAL,
        legacyWorkspaceId: LEGACY_ID,
        expectedFileName: FILE_NAME,
        workspaceRoot,
        capturedSeatId: SEAT_B,
      },
      { ensureEditHandle }
    );

    expect(result).toEqual({ ok: false, reason: 'invalid-request' });
    expect(ensureEditHandle).not.toHaveBeenCalled();
    expect(listActiveImageArtifacts(dataRoot, CANONICAL, SEAT_B)).toEqual([]);
  });

  it('the workspace-id fence: only hermes-temp-<canonical> exactly is accepted', () => {
    const attempt = (legacyWorkspaceId: string) =>
      importLegacyImageArtifact(dataRoot, {
        conversationId: CANONICAL,
        legacyWorkspaceId,
        expectedFileName: FILE_NAME,
        workspaceRoot,
        capturedSeatId: LEGACY_SEAT,
      });
    // Positive control first: the exact shape IS accepted.
    grantLegacyFileRead();
    expect(attempt(LEGACY_ID).ok).toBe(true);
    // A different conversation's folder, an arbitrary id, the canonical id
    // itself, and near-miss spellings are all refused — no mapping table, no
    // heuristic.
    expect(attempt('hermes-temp-other9')).toEqual({ ok: false, reason: 'workspace-id-mismatch' });
    expect(attempt('some-random-folder')).toEqual({ ok: false, reason: 'workspace-id-mismatch' });
    expect(attempt(CANONICAL)).toEqual({ ok: false, reason: 'workspace-id-mismatch' });
    expect(attempt(`hermes-tmp-${CANONICAL}`)).toEqual({ ok: false, reason: 'workspace-id-mismatch' });
    expect(attempt(`hermes-temp-${CANONICAL}-extra`)).toEqual({ ok: false, reason: 'workspace-id-mismatch' });
  });

  it('refuses traversal, subdirectory, absolute and wrong names', () => {
    const attempt = (expectedFileName: string) =>
      importLegacyImageArtifact(dataRoot, {
        conversationId: CANONICAL,
        legacyWorkspaceId: LEGACY_ID,
        expectedFileName,
        workspaceRoot,
        capturedSeatId: LEGACY_SEAT,
      });
    expect(attempt('../outside.png')).toEqual({ ok: false, reason: 'invalid-request' });
    expect(attempt('../../etc/passwd.png')).toEqual({ ok: false, reason: 'invalid-request' });
    expect(attempt('sub/dir.png')).toEqual({ ok: false, reason: 'invalid-request' });
    expect(attempt('/etc/absolute.png')).toEqual({ ok: false, reason: 'invalid-request' });
    expect(attempt('..')).toEqual({ ok: false, reason: 'invalid-request' });
    // A safe name that does not exist is a miss, not a confinement breach.
    expect(attempt('img-does-not-exist.png')).toEqual({ ok: false, reason: 'file-missing' });
    // A safe name with an unsupported extension is not an image.
    fs.writeFileSync(path.join(workspaceRoot, 'notes.txt'), 'text');
    expect(attempt('notes.txt')).toEqual({ ok: false, reason: 'unsupported-file' });
    expect(listActiveImageArtifacts(dataRoot, CANONICAL, SEAT_A)).toEqual([]);
  });

  it('refuses a file outside the root reached through a symlinked parent', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-legacy-outside-'));
    try {
      fs.writeFileSync(path.join(outside, FILE_NAME), fileBytes);
      const linkRoot = path.join(os.tmpdir(), `ceve-legacy-link-${process.pid}`);
      fs.rmSync(linkRoot, { recursive: true, force: true });
      fs.symlinkSync(outside, linkRoot);
      // The expected name under a root whose REALPATH is a different directory
      // still resolves exactly — that case is legitimately confined…
      grantLegacyFileRead(LEGACY_SEAT, linkRoot);
      const viaLink = importLegacyImageArtifact(dataRoot, {
        conversationId: CANONICAL,
        legacyWorkspaceId: LEGACY_ID,
        expectedFileName: FILE_NAME,
        workspaceRoot: linkRoot,
        capturedSeatId: LEGACY_SEAT,
      });
      expect(viaLink.ok).toBe(true);
      // …but a symlinked FILE inside the real root is refused.
      fs.symlinkSync(path.join(outside, FILE_NAME), path.join(workspaceRoot, 'img-link.png'));
      expect(
        importLegacyImageArtifact(dataRoot, {
          conversationId: CANONICAL,
          legacyWorkspaceId: LEGACY_ID,
          expectedFileName: 'img-link.png',
          workspaceRoot,
          capturedSeatId: LEGACY_SEAT,
        })
      ).toEqual({ ok: false, reason: 'file-unreadable' });
      fs.rmSync(linkRoot, { recursive: true, force: true });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
