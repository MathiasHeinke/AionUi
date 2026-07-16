import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  canonicalizeColibriTree,
  estimateReusableColibriBytes,
  isSafeColibriSnapshotPath,
  readColibriInstallStatus,
  validateColibriTree,
} from '@/process/commandEve/localInference/colibriProvisioner';
import {
  COLIBRI_MODEL_SNAPSHOT,
  COLIBRI_MTP_PINS,
  COLIBRI_SOURCE,
  COMMAND_EVE_COLIBRI_VERSION,
  resolveColibriPaths,
} from '@/process/commandEve/localInference/colibriManifest';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Colibrì provisioner integrity core', () => {
  it('uses byte-stable canonical tree records', () => {
    expect(
      canonicalizeColibriTree([
        { path: 'z', sizeBytes: 2, hashKind: 'sha256', hash: 'b'.repeat(64) },
        { path: 'a', sizeBytes: 1, hashKind: 'git-sha1', hash: 'a'.repeat(40) },
      ])
    ).toBe(`a${'\0'}1${'\0'}git-sha1${'\0'}${'a'.repeat(40)}\nz${'\0'}2${'\0'}sha256${'\0'}${'b'.repeat(64)}\n`);

    expect(
      canonicalizeColibriTree([
        { path: 'config.json', sizeBytes: 2, hashKind: 'git-sha1', hash: 'b'.repeat(40) },
        { path: 'README.md', sizeBytes: 1, hashKind: 'git-sha1', hash: 'a'.repeat(40) },
      ])
    ).toBe(
      `README.md${'\0'}1${'\0'}git-sha1${'\0'}${'a'.repeat(40)}\n` +
        `config.json${'\0'}2${'\0'}git-sha1${'\0'}${'b'.repeat(40)}\n`
    );
  });

  it('rejects traversal, absolute, Windows and empty snapshot paths', () => {
    expect(isSafeColibriSnapshotPath('model/config.json')).toBe(true);
    expect(isSafeColibriSnapshotPath('../secret')).toBe(false);
    expect(isSafeColibriSnapshotPath('/absolute')).toBe(false);
    expect(isSafeColibriSnapshotPath('a\\b')).toBe(false);
    expect(isSafeColibriSnapshotPath('')).toBe(false);
  });

  it('fails closed before accepting a malformed or incomplete Hugging Face tree', () => {
    expect(() => validateColibriTree([{ type: 'file', path: '../escape', size: 1, oid: 'a'.repeat(40) }])).toThrow(
      /invalid file entry/i
    );
    expect(() => validateColibriTree([{ type: 'file', path: 'config.json', size: 1, oid: 'a'.repeat(40) }])).toThrow(
      /pinned snapshot manifest/i
    );
  });

  it('credits only resumable partial files with matching pinned metadata during disk admission', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-colibri-resume-'));
    roots.push(root);
    const files = [
      { path: 'valid.bin', sizeBytes: 10, hashKind: 'sha256' as const, hash: 'a'.repeat(64) },
      { path: 'invalid.bin', sizeBytes: 10, hashKind: 'sha256' as const, hash: 'b'.repeat(64) },
    ];
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'valid.bin.part'), '1234');
    fs.writeFileSync(
      path.join(root, 'valid.bin.part.json'),
      JSON.stringify({ hash: files[0].hash, size: files[0].sizeBytes, etag: 'pinned' })
    );
    fs.writeFileSync(path.join(root, 'invalid.bin'), '12');
    fs.writeFileSync(path.join(root, 'invalid.bin.part'), '123');
    fs.writeFileSync(
      path.join(root, 'invalid.bin.part.json'),
      JSON.stringify({ hash: 'c'.repeat(64), size: files[1].sizeBytes })
    );

    expect(estimateReusableColibriBytes(root, files)).toBe(6);
  });

  it('surfaces resume only from progress bound to the current pinned Colibrì snapshot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-colibri-progress-'));
    roots.push(root);
    const paths = resolveColibriPaths(root);
    fs.mkdirSync(path.dirname(paths.provisionProgressPath), { recursive: true });
    const progress = {
      version: 'command-eve-colibri-provision-progress/v0',
      model_revision: COLIBRI_MODEL_SNAPSHOT.revision,
      tree_sha256: COLIBRI_MODEL_SNAPSHOT.treeSha256,
      status: 'failed',
      stage: 'download',
      total: COLIBRI_MODEL_SNAPSHOT.totalSizeBytes + COLIBRI_SOURCE.sizeBytes,
      completed: 300_000_000_000,
      percent: 78,
      updated_at: '2026-07-16T12:00:00.000Z',
    };
    fs.writeFileSync(paths.provisionProgressPath, JSON.stringify(progress));
    expect(readColibriInstallStatus(root)).toMatchObject({ installed: false, resumeAvailable: true, progress });

    fs.writeFileSync(paths.provisionProgressPath, JSON.stringify({ ...progress, tree_sha256: '0'.repeat(64) }));
    expect(readColibriInstallStatus(root)).toEqual({ installed: false });
  });

  it('recognizes only a receipt bound to the pinned model, source, engine and int8 MTP sizes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-colibri-status-'));
    roots.push(root);
    const paths = resolveColibriPaths(root);
    fs.mkdirSync(path.dirname(paths.cliPath), { recursive: true });
    fs.mkdirSync(paths.modelDir, { recursive: true });
    fs.writeFileSync(paths.cliPath, '#!/usr/bin/env python3\n');
    fs.writeFileSync(paths.enginePath, 'engine');
    for (const pin of COLIBRI_MTP_PINS) {
      const target = path.join(paths.modelDir, pin.path);
      fs.closeSync(fs.openSync(target, 'w'));
      fs.truncateSync(target, pin.sizeBytes);
    }
    fs.writeFileSync(
      paths.receiptPath,
      JSON.stringify({
        version: COMMAND_EVE_COLIBRI_VERSION,
        status: 'ready',
        model: {
          revision: COLIBRI_MODEL_SNAPSHOT.revision,
          tree_sha256: COLIBRI_MODEL_SNAPSHOT.treeSha256,
          size_bytes: COLIBRI_MODEL_SNAPSHOT.totalSizeBytes,
        },
        runtime: { source_commit: COLIBRI_SOURCE.commit, engine_sha256: 'a'.repeat(64) },
      })
    );
    expect(readColibriInstallStatus(root)).toMatchObject({
      installed: true,
      installedSizeBytes: COLIBRI_MODEL_SNAPSHOT.totalSizeBytes,
    });
    fs.truncateSync(path.join(paths.modelDir, COLIBRI_MTP_PINS[0].path), 1);
    expect(readColibriInstallStatus(root).installed).toBe(false);
  });
});
