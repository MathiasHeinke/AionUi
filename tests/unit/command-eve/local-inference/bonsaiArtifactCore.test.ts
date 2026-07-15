import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertPinnedHttpsArtifact,
  buildResumeDecision,
  isSafeArchiveEntry,
  isSafeSymlinkTarget,
  verifyPinnedArtifactFile,
} from '@/process/commandEve/localInference/bonsaiArtifactCore';
import type { BonsaiPinnedArtifact } from '@/process/commandEve/localInference/bonsaiManifest';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Bonsai artifact integrity core', () => {
  it('requires a pinned HTTPS URL, byte size, and SHA256', () => {
    const valid: BonsaiPinnedArtifact = {
      id: 'model',
      url: 'https://example.test/model.gguf',
      fileName: 'model.gguf',
      sizeBytes: 7,
      sha256: 'a'.repeat(64),
    };
    expect(() => assertPinnedHttpsArtifact(valid)).not.toThrow();
    expect(() => assertPinnedHttpsArtifact({ ...valid, url: 'http://example.test/model.gguf' })).toThrow(/HTTPS/);
    expect(() => assertPinnedHttpsArtifact({ ...valid, sha256: 'mutable-latest' })).toThrow(/SHA256/);
  });

  it('resumes only when a trusted ETag binds a proper partial file', () => {
    expect(buildResumeDecision({ partialSizeBytes: 5, expectedSizeBytes: 10, etag: '"v1"' })).toEqual({
      append: true,
      offset: 5,
      headers: { range: 'bytes=5-', 'if-range': '"v1"' },
    });
    expect(buildResumeDecision({ partialSizeBytes: 5, expectedSizeBytes: 10 })).toEqual({
      append: false,
      offset: 0,
      headers: {},
    });
    expect(buildResumeDecision({ partialSizeBytes: 10, expectedSizeBytes: 10, etag: '"v1"' }).append).toBe(false);
  });

  it('rejects archive traversal and escaping symlinks while allowing release-local dylib links', () => {
    expect(isSafeArchiveEntry('./')).toBe(true);
    expect(isSafeArchiveEntry('runtime/llama-server')).toBe(true);
    expect(isSafeArchiveEntry('../outside')).toBe(false);
    expect(isSafeArchiveEntry('/absolute/path')).toBe(false);
    expect(isSafeArchiveEntry('runtime\\outside')).toBe(false);

    const root = '/private/runtime';
    expect(isSafeSymlinkTarget(root, '/private/runtime/lib/libggml.dylib', 'libggml.0.dylib')).toBe(true);
    expect(isSafeSymlinkTarget(root, '/private/runtime/lib/libggml.dylib', '../../../etc/passwd')).toBe(false);
    expect(isSafeSymlinkTarget(root, '/private/runtime/lib/libggml.dylib', '/etc/passwd')).toBe(false);
  });

  it('rehashes the complete assembled file and rejects same-size tampering', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bonsai-artifact-'));
    roots.push(root);
    const file = path.join(root, 'model.gguf');
    const expected = Buffer.from('trusted');
    fs.writeFileSync(file, expected);
    const artifact: BonsaiPinnedArtifact = {
      id: 'model',
      url: 'https://example.test/model.gguf',
      fileName: 'model.gguf',
      sizeBytes: expected.length,
      sha256: crypto.createHash('sha256').update(expected).digest('hex'),
    };

    await expect(verifyPinnedArtifactFile(file, artifact)).resolves.toMatchObject({ ok: true });
    fs.writeFileSync(file, Buffer.from('changed'));
    await expect(verifyPinnedArtifactFile(file, artifact)).resolves.toMatchObject({
      ok: false,
      error: 'sha256 mismatch',
    });
  });
});
