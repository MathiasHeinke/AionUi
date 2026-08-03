/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1769 (requirement 9) — the durable sent-image registry behind the
 * artifact envelope's kind=image entries.
 *
 * Pinned properties: first-write-wins idempotency (a retried send never
 * reorders the registry), content-hash identity (same bytes, one record),
 * unsafe-id refusal, malformed-record tolerance, and the no-bytes/no-path
 * shape of what is persisted at all.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  imageArtifactIdForSha256,
  imageMimeTypeFromPath,
  listImageArtifactRecords,
  saveImageArtifactRecord,
  type CommandEveImageArtifactRecord,
} from '@/process/commandEve/visual/imageArtifactRecordStore';

let dataRoot: string;

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const record = (overrides: Partial<CommandEveImageArtifactRecord> = {}): CommandEveImageArtifactRecord => ({
  id: imageArtifactIdForSha256(SHA_A),
  conversation_id: 'conv-1',
  sha256: SHA_A,
  mimeType: 'image/png',
  created_at: 1000,
  ...overrides,
});

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-image-artifacts-'));
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('imageArtifactRecordStore — MAT-1769 sent-image registry', () => {
  it('persists and lists records oldest first, carrying no path and no bytes', () => {
    saveImageArtifactRecord(dataRoot, record({ created_at: 2000 }));
    saveImageArtifactRecord(dataRoot, record({ id: imageArtifactIdForSha256(SHA_B), sha256: SHA_B, created_at: 1000 }));

    const records = listImageArtifactRecords(dataRoot, 'conv-1');
    expect(records).toHaveLength(2);
    expect(records[0]?.created_at).toBe(1000);
    expect(records[1]?.created_at).toBe(2000);
    for (const entry of records) {
      expect(Object.keys(entry).toSorted()).toEqual(['conversation_id', 'created_at', 'id', 'mimeType', 'sha256']);
      expect(JSON.stringify(entry)).not.toContain(dataRoot);
    }
  });

  it('is idempotent by content hash: first write wins and keeps the original timestamp', () => {
    saveImageArtifactRecord(dataRoot, record({ created_at: 1000 }));
    // The restored/retried send: same bytes, later attempt — must NOT reorder.
    saveImageArtifactRecord(dataRoot, record({ created_at: 9999 }));

    const records = listImageArtifactRecords(dataRoot, 'conv-1');
    expect(records).toHaveLength(1);
    expect(records[0]?.created_at).toBe(1000);
  });

  it('scopes records to their conversation', () => {
    saveImageArtifactRecord(dataRoot, record());
    expect(listImageArtifactRecords(dataRoot, 'conv-2')).toEqual([]);
  });

  it('refuses unsafe ids, unsafe conversations and malformed hashes silently', () => {
    saveImageArtifactRecord(dataRoot, record({ id: '../escape' }));
    saveImageArtifactRecord(dataRoot, record({ conversation_id: '../escape' }));
    saveImageArtifactRecord(dataRoot, record({ sha256: 'not-a-sha' }));
    saveImageArtifactRecord(dataRoot, record({ created_at: Number.NaN }));
    expect(listImageArtifactRecords(dataRoot, 'conv-1')).toEqual([]);
    // Nothing escaped the manifest root either.
    expect(fs.existsSync(path.join(dataRoot, 'escape.json'))).toBe(false);
  });

  it('refuses to list for an unsafe conversation id', () => {
    expect(listImageArtifactRecords(dataRoot, '../etc')).toEqual([]);
  });

  it('tolerates malformed manifests instead of failing the listing', () => {
    saveImageArtifactRecord(dataRoot, record());
    const dir = path.join(dataRoot, 'command-eve-image-artifacts', 'conv-1');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json', 'utf8');
    fs.writeFileSync(
      path.join(dir, 'wrong-shape.json'),
      JSON.stringify({ id: 'image-x', conversation_id: 'conv-1', sha256: 42 }),
      'utf8'
    );

    const records = listImageArtifactRecords(dataRoot, 'conv-1');
    expect(records).toHaveLength(1);
    expect(records[0]?.sha256).toBe(SHA_A);
  });

  it('derives a stable opaque id from the content hash', () => {
    expect(imageArtifactIdForSha256(SHA_A)).toBe(`image-${'a'.repeat(16)}`);
    expect(imageArtifactIdForSha256(SHA_A)).toBe(imageArtifactIdForSha256(SHA_A));
  });

  it('maps the extensions the local image boundary accepts, and stays generic otherwise', () => {
    expect(imageMimeTypeFromPath('/tmp/a.png')).toBe('image/png');
    expect(imageMimeTypeFromPath('/tmp/a.JPG')).toBe('image/jpeg');
    expect(imageMimeTypeFromPath('/tmp/a.jpeg')).toBe('image/jpeg');
    expect(imageMimeTypeFromPath('/tmp/a.webp')).toBe('image/webp');
    expect(imageMimeTypeFromPath('/tmp/a.gif')).toBe('image/gif');
    expect(imageMimeTypeFromPath('/tmp/a.tiff')).toBe('image/*');
    expect(imageMimeTypeFromPath('/tmp/no-extension')).toBe('image/*');
  });
});
