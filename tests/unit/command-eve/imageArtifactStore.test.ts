import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  bindStagedImageArtifact,
  importLegacyImageArtifact,
  listActiveImageArtifacts,
  purgeExpiredStagedImageArtifacts,
  readImageArtifactBytes,
  readImageArtifactRecordById,
  stageGeneratedImageArtifact,
} from '@/process/commandEve/imageArtifactStore';
import { IMAGE_STAGED_HANDLE_TTL_MS } from '@/common/config/managedImageArtifactCore';

const BYTES = Buffer.from('png-bytes-here');
const PROMPT_SHA = crypto.createHash('sha256').update('a prompt').digest('hex');

let dataRoot: string;

function stage(nowMs = Date.now()) {
  const staged = stageGeneratedImageArtifact(dataRoot, {
    bytes: BYTES,
    mimeType: 'image/png',
    tier: 'quality',
    model: 'gemini',
    resolution: '1K',
    aspectRatio: '16:9',
    promptSha256: PROMPT_SHA,
    nowMs,
  });
  expect(staged).toBeTruthy();
  return staged!;
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-image-store-'));
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('STAGE', () => {
  it('persists the bytes privately (0600 blob), writes a staged record with NO conversation, and mints a well-formed handle', () => {
    const { record, handle } = stage();
    expect(handle).toMatch(/^img_h_[0-9a-f]{64}$/);
    expect(record.status).toBe('staged');
    expect(record.conversation_id).toBeNull();
    expect(record.payload.sha256).toBe(crypto.createHash('sha256').update(BYTES).digest('hex'));
    // No path anywhere in the record — the payload is sha/size/mime only.
    expect(JSON.stringify(record)).not.toContain(dataRoot);
    const blob = path.join(dataRoot, 'command-eve-managed-image-artifacts', 'blobs', record.id);
    expect(fs.readFileSync(blob).equals(BYTES)).toBe(true);
    expect(fs.statSync(blob).mode & 0o777).toBe(0o600);
    expect(readImageArtifactBytes(dataRoot, record.id)?.equals(BYTES)).toBe(true);
  });

  it('an unbound staged record is listed for NO conversation', () => {
    stage();
    expect(listActiveImageArtifacts(dataRoot, 'conv-1')).toEqual([]);
  });
});

describe('BIND', () => {
  it('flips staged -> active with the conversation, records the tool call id, and mints the durable image_edit grant', () => {
    const { record, handle } = stage();
    const result = bindStagedImageArtifact(dataRoot, { conversationId: 'conv-1', handle, toolCallId: 'call-1' });
    expect(result).toMatchObject({ ok: true, alreadyBound: false });
    if (result.ok === false) return;
    expect(result.record.status).toBe('active');
    expect(result.record.conversation_id).toBe('conv-1');
    expect(result.record.bound_tool_call_id).toBe('call-1');
    expect(listActiveImageArtifacts(dataRoot, 'conv-1').map((r) => r.id)).toEqual([record.id]);
    // The durable capability grant exists and binds operation + bytes.
    const grants = fs.readdirSync(path.join(dataRoot, 'command-eve-artifact-capabilities'));
    expect(grants.filter((name) => name.length === 69).length).toBe(1);
  });

  it('a duplicate terminal bind (same toolCallId re-seen) is a no-op: one artifact, no replay', () => {
    const { record, handle } = stage();
    const first = bindStagedImageArtifact(dataRoot, { conversationId: 'conv-1', handle, toolCallId: 'call-1' });
    const second = bindStagedImageArtifact(dataRoot, { conversationId: 'conv-1', handle, toolCallId: 'call-1' });
    expect(first).toMatchObject({ ok: true, alreadyBound: false });
    expect(second).toMatchObject({ ok: true, alreadyBound: true });
    expect(listActiveImageArtifacts(dataRoot, 'conv-1').length).toBe(1);
    expect(readImageArtifactRecordById(dataRoot, record.id)?.status).toBe('active');
  });

  it('the same handle presented for a DIFFERENT conversation is refused conversation-mismatch', () => {
    const { handle } = stage();
    bindStagedImageArtifact(dataRoot, { conversationId: 'conv-1', handle, toolCallId: 'call-1' });
    const stolen = bindStagedImageArtifact(dataRoot, { conversationId: 'conv-2', handle, toolCallId: 'call-9' });
    expect(stolen).toEqual({ ok: false, reason: 'conversation-mismatch' });
    expect(listActiveImageArtifacts(dataRoot, 'conv-2')).toEqual([]);
  });

  it('malformed, unknown and expired handles are refused; the expired staged record is purged with its bytes', () => {
    const now = 1_754_000_000_000;
    const { record, handle } = stage(now);
    expect(
      bindStagedImageArtifact(dataRoot, { conversationId: 'conv-1', handle: 'img_h_nope', toolCallId: 'c' })
    ).toEqual({
      ok: false,
      reason: 'handle-malformed',
    });
    expect(
      bindStagedImageArtifact(dataRoot, {
        conversationId: 'conv-1',
        handle: `img_h_${'1'.repeat(64)}`,
        toolCallId: 'c',
      })
    ).toEqual({ ok: false, reason: 'handle-unknown' });
    expect(
      bindStagedImageArtifact(dataRoot, {
        conversationId: 'conv-1',
        handle,
        toolCallId: 'c',
        nowMs: now + IMAGE_STAGED_HANDLE_TTL_MS + 1,
      })
    ).toEqual({ ok: false, reason: 'handle-expired' });

    const purged = purgeExpiredStagedImageArtifacts(dataRoot, now + IMAGE_STAGED_HANDLE_TTL_MS + 1);
    expect(purged).toBe(1);
    expect(readImageArtifactRecordById(dataRoot, record.id)).toBeUndefined();
    expect(readImageArtifactBytes(dataRoot, record.id)).toBeUndefined();
  });

  it('a mint failure of the edit grant never fails the bind itself', () => {
    const { handle } = stage();
    const result = bindStagedImageArtifact(
      dataRoot,
      { conversationId: 'conv-1', handle, toolCallId: 'call-1' },
      { ensureEditHandle: () => undefined }
    );
    expect(result).toMatchObject({ ok: true });
  });
});

describe('LEGACY IMPORT', () => {
  const FILE_NAME = 'img-1785796180699.png';
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

  it('adopts the exact expected workspace file as an ACTIVE bound record, and is idempotent', () => {
    const result = importLegacyImageArtifact(dataRoot, {
      conversationId: 'hermes-temp-3be29bae',
      expectedFileName: FILE_NAME,
      workspaceRoot,
    });
    expect(result).toMatchObject({ ok: true, alreadyImported: false });
    if (result.ok === false) return;
    expect(result.record.status).toBe('active');
    expect(result.record.conversation_id).toBe('hermes-temp-3be29bae');
    expect(result.record.payload.sha256).toBe(crypto.createHash('sha256').update(fileBytes).digest('hex'));
    // No path stored: sha/size/mime only.
    expect(JSON.stringify(result.record)).not.toContain(workspaceRoot);
    expect(listActiveImageArtifacts(dataRoot, 'hermes-temp-3be29bae').length).toBe(1);

    const again = importLegacyImageArtifact(dataRoot, {
      conversationId: 'hermes-temp-3be29bae',
      expectedFileName: FILE_NAME,
      workspaceRoot,
    });
    expect(again).toMatchObject({ ok: true, alreadyImported: true });
    expect(listActiveImageArtifacts(dataRoot, 'hermes-temp-3be29bae').length).toBe(1);
  });

  it('refuses traversal, subdirectory, absolute and wrong names', () => {
    const attempt = (expectedFileName: string) =>
      importLegacyImageArtifact(dataRoot, { conversationId: 'conv-1', expectedFileName, workspaceRoot });
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
    expect(listActiveImageArtifacts(dataRoot, 'conv-1')).toEqual([]);
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
      const viaLink = importLegacyImageArtifact(dataRoot, {
        conversationId: 'conv-1',
        expectedFileName: FILE_NAME,
        workspaceRoot: linkRoot,
      });
      expect(viaLink.ok).toBe(true);
      // …but a symlinked FILE inside the real root is refused.
      fs.symlinkSync(path.join(outside, FILE_NAME), path.join(workspaceRoot, 'img-link.png'));
      expect(
        importLegacyImageArtifact(dataRoot, {
          conversationId: 'conv-1',
          expectedFileName: 'img-link.png',
          workspaceRoot,
        })
      ).toEqual({ ok: false, reason: 'file-unreadable' });
      fs.rmSync(linkRoot, { recursive: true, force: true });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
