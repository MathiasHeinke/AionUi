/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The local, desktop-owned durability layer for managed video artifacts.
 *
 * AionCore's own artifact store never learns about a video generated through
 * the direct Main -> gateway call. Without these tests, "survives a reload"
 * would rest entirely on trusting the bridge's fs calls did the right thing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandEveVideoConversationArtifact } from '@/common/config/videoGenerationRequestCore';
import {
  listVideoArtifactRecords,
  saveGeneratedVideoFile,
  saveVideoArtifactRecord,
} from '@/process/commandEve/videoArtifactStore';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-video-artifact-store-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Record every path whose descriptor was fsynced.
 *
 * A durability test that only asserts "the file is there afterwards" passes on
 * the very implementation this store had before — `writeFileSync` + `rename`
 * leaves the file visible and the bytes unflushed. So the measurement has to be
 * the fsync itself, on the data descriptor AND on the publishing directory.
 */
function recordFsyncedPaths(): string[] {
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
  return fsyncedFiles;
}

function makeArtifact(
  overrides: Partial<CommandEveVideoConversationArtifact> = {}
): CommandEveVideoConversationArtifact {
  return {
    id: 'artifact-1',
    conversation_id: 'conv-1',
    kind: 'video',
    status: 'active',
    payload: {
      artifact_type: 'video',
      title: 'Video 720p',
      description: '720p · 5s · ca. 700 Credits · grok-imagine-video',
      path: '/tmp/somewhere/artifact-1.mp4',
      mime_type: 'video/mp4',
      hash: 'a'.repeat(64),
      size: 3,
    },
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

describe('saveGeneratedVideoFile', () => {
  it('writes a canonical visible project file with a prompt-derived name', () => {
    const workspace = path.join(tmpRoot, 'workspace');
    const dataPath = path.join(tmpRoot, 'data');
    fs.mkdirSync(workspace);
    fs.mkdirSync(dataPath);
    const saved = saveGeneratedVideoFile({
      conversationId: 'conv-1',
      artifactId: 'artifact-visible',
      dataBase64: Buffer.from('video').toString('base64'),
      mimeType: 'video/mp4',
      dataPath,
      workspaceRoot: workspace,
      nameHint: 'Launch Film',
      nowMs: new Date(2026, 7, 17, 12).getTime(),
    });
    expect(path.relative(workspace, saved.path)).toBe(path.join('videos', 'launch-film-2026-08-17.mp4'));
    expect(fs.readFileSync(saved.path, 'utf8')).toBe('video');
  });

  it('writes the exact decoded bytes to a stable, conversation-scoped path', () => {
    const dataBase64 = Buffer.from('hello video').toString('base64');
    const saved = saveGeneratedVideoFile({
      conversationId: 'conv-1',
      artifactId: 'artifact-1',
      dataBase64,
      mimeType: 'video/mp4',
      downloadsRoot: tmpRoot,
    });

    expect(saved.path.endsWith('artifact-1.mp4')).toBe(true);
    expect(fs.readFileSync(saved.path, 'utf8')).toBe('hello video');
  });

  it('picks the extension from the mime type', () => {
    const saved = saveGeneratedVideoFile({
      conversationId: 'conv-1',
      artifactId: 'artifact-2',
      dataBase64: 'AAAA',
      mimeType: 'video/webm',
      downloadsRoot: tmpRoot,
    });
    expect(saved.path.endsWith('.webm')).toBe(true);
  });

  it('falls back to a safe directory name for an unsafe conversation id', () => {
    const saved = saveGeneratedVideoFile({
      conversationId: '../../etc',
      artifactId: 'artifact-3',
      dataBase64: 'AAAA',
      mimeType: 'video/mp4',
      downloadsRoot: tmpRoot,
    });
    expect(path.resolve(saved.path).startsWith(path.resolve(tmpRoot))).toBe(true);
    expect(saved.path).not.toContain('../../etc');
  });
});

describe('saveVideoArtifactRecord + listVideoArtifactRecords — survives a reload', () => {
  it('saves an artifact and lists it back for the same conversation', () => {
    const artifact = makeArtifact();
    saveVideoArtifactRecord(tmpRoot, artifact);

    // A fresh call — exactly what happens when a conversation view remounts —
    // must find the same artifact without anything still in memory.
    const listed = listVideoArtifactRecords(tmpRoot, 'conv-1');
    expect(listed).toHaveLength(1);
    // Identity and the stored payload survive verbatim...
    expect(listed[0].id).toBe(artifact.id);
    expect(listed[0].conversation_id).toBe(artifact.conversation_id);
    expect(listed[0].created_at).toBe(artifact.created_at);
    expect(listed[0].payload.path).toBe(artifact.payload.path);
    expect(listed[0].payload.hash).toBe(artifact.payload.hash);
    // ...and the read HYDRATES the MAT-1748 registry fields, so a record written
    // before they existed still answers the questions an edit has to ask. This
    // is deliberately not `toEqual(artifact)` any more: the fixture here is the
    // legacy shape, and demanding it back byte-identical would be demanding that
    // old clips stay unusable.
    expect(listed[0].payload.duration_seconds).toBe(5);
    expect(listed[0].payload.origin_capability).toBe('video_generation');
  });

  it('never leaks another conversation’s artifacts', () => {
    saveVideoArtifactRecord(tmpRoot, makeArtifact({ id: 'a', conversation_id: 'conv-1' }));
    saveVideoArtifactRecord(tmpRoot, makeArtifact({ id: 'b', conversation_id: 'conv-2' }));

    expect(listVideoArtifactRecords(tmpRoot, 'conv-1').map((a) => a.id)).toEqual(['a']);
    expect(listVideoArtifactRecords(tmpRoot, 'conv-2').map((a) => a.id)).toEqual(['b']);
  });

  it('shows an owned record only to its Seat, while legacy records remain legacy-only', () => {
    const seatA = 'a2000000-0000-4000-8000-000000000001';
    const seatB = 'b2000000-0000-4000-8000-000000000001';
    saveVideoArtifactRecord(tmpRoot, makeArtifact({ id: 'seat-a', seat_id: seatA }));
    saveVideoArtifactRecord(tmpRoot, makeArtifact({ id: 'legacy' }));

    expect(listVideoArtifactRecords(tmpRoot, 'conv-1', seatA).map((artifact) => artifact.id)).toEqual(['seat-a']);
    expect(listVideoArtifactRecords(tmpRoot, 'conv-1', seatB)).toEqual([]);
    expect(listVideoArtifactRecords(tmpRoot, 'conv-1', 'seat-1').map((artifact) => artifact.id)).toEqual(['legacy']);
  });

  it('returns an empty list for a conversation with nothing saved', () => {
    expect(listVideoArtifactRecords(tmpRoot, 'never-had-a-video')).toEqual([]);
  });

  it('orders multiple artifacts oldest first', () => {
    saveVideoArtifactRecord(tmpRoot, makeArtifact({ id: 'newer', created_at: 2000, updated_at: 2000 }));
    saveVideoArtifactRecord(tmpRoot, makeArtifact({ id: 'older', created_at: 1000, updated_at: 1000 }));

    expect(listVideoArtifactRecords(tmpRoot, 'conv-1').map((a) => a.id)).toEqual(['older', 'newer']);
  });

  it('ignores a corrupt manifest file instead of throwing', () => {
    const directory = path.join(tmpRoot, 'command-eve-video-artifacts', 'conv-1');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'broken.json'), '{ not json');

    expect(() => listVideoArtifactRecords(tmpRoot, 'conv-1')).not.toThrow();
    expect(listVideoArtifactRecords(tmpRoot, 'conv-1')).toEqual([]);
  });

  it('refuses to write or read an unsafe conversation id', () => {
    saveVideoArtifactRecord(tmpRoot, makeArtifact({ conversation_id: '../escape' }));
    expect(listVideoArtifactRecords(tmpRoot, '../escape')).toEqual([]);
    expect(fs.existsSync(path.join(tmpRoot, 'command-eve-video-artifacts', '..', 'escape'))).toBe(false);
  });
});

describe('DURABILITY — a paid video survives a power cut, not just a remount', () => {
  it('fsyncs the manifest record and the directory that publishes it', () => {
    const fsynced = recordFsyncedPaths();
    const artifact = makeArtifact();

    saveVideoArtifactRecord(tmpRoot, artifact);

    const recordFile = path.join(tmpRoot, 'command-eve-video-artifacts', 'conv-1', `${artifact.id}.json`);
    // Flushed while still under its temp name — after the rename it is too late
    // for the bytes, and a lost record is a paid video gone from the artifact
    // list with no rehydration path to bring it back.
    expect(fsynced.some((file) => path.basename(file).includes(path.basename(recordFile)))).toBe(true);
    expect(fsynced).toContain(path.dirname(recordFile));
  });

  it('fsyncs the generated video bytes and their directory', () => {
    const fsynced = recordFsyncedPaths();

    const saved = saveGeneratedVideoFile({
      conversationId: 'conv-1',
      artifactId: 'artifact-durable',
      dataBase64: Buffer.from('hello video').toString('base64'),
      mimeType: 'video/mp4',
      downloadsRoot: tmpRoot,
    });

    expect(fsynced.some((file) => path.basename(file).includes(path.basename(saved.path)))).toBe(true);
    expect(fsynced).toContain(path.dirname(saved.path));
    expect(fs.readFileSync(saved.path, 'utf8')).toBe('hello video');
  });
});
