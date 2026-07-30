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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

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
  it('writes the exact decoded bytes to a stable, conversation-scoped path', () => {
    const dataBase64 = Buffer.from('hello video').toString('base64');
    const savedPath = saveGeneratedVideoFile({
      conversationId: 'conv-1',
      artifactId: 'artifact-1',
      dataBase64,
      mimeType: 'video/mp4',
      downloadsRoot: tmpRoot,
    });

    expect(savedPath.endsWith('artifact-1.mp4')).toBe(true);
    expect(fs.readFileSync(savedPath, 'utf8')).toBe('hello video');
  });

  it('picks the extension from the mime type', () => {
    const savedPath = saveGeneratedVideoFile({
      conversationId: 'conv-1',
      artifactId: 'artifact-2',
      dataBase64: 'AAAA',
      mimeType: 'video/webm',
      downloadsRoot: tmpRoot,
    });
    expect(savedPath.endsWith('.webm')).toBe(true);
  });

  it('falls back to a safe directory name for an unsafe conversation id', () => {
    const savedPath = saveGeneratedVideoFile({
      conversationId: '../../etc',
      artifactId: 'artifact-3',
      dataBase64: 'AAAA',
      mimeType: 'video/mp4',
      downloadsRoot: tmpRoot,
    });
    expect(path.resolve(savedPath).startsWith(path.resolve(tmpRoot))).toBe(true);
    expect(savedPath).not.toContain('../../etc');
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
    expect(listed[0]).toEqual(artifact);
  });

  it('never leaks another conversation’s artifacts', () => {
    saveVideoArtifactRecord(tmpRoot, makeArtifact({ id: 'a', conversation_id: 'conv-1' }));
    saveVideoArtifactRecord(tmpRoot, makeArtifact({ id: 'b', conversation_id: 'conv-2' }));

    expect(listVideoArtifactRecords(tmpRoot, 'conv-1').map((a) => a.id)).toEqual(['a']);
    expect(listVideoArtifactRecords(tmpRoot, 'conv-2').map((a) => a.id)).toEqual(['b']);
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
