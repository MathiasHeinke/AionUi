/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCommandEveImageVisionRequest,
  mergeCommandEvePreparedImageFiles,
  parseCommandEveImageVisionResponse,
} from '@/common/config/eveImageIntelligenceCore';
import {
  CommandEveImagePreparationError,
  inspectLocalImage,
  prepareImageWithVision,
} from '@/process/commandEve/document/imageIntelligenceService';

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-image-intelligence-'));
  temporaryDirectories.push(root);
  return root;
}

function pngBytes(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x49, 0x45, 0x4e, 0x44,
  ]);
}

function jpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Command EVE image intelligence', () => {
  it('builds a keyless, bounded, ZDR-only image request and validates its receipt', () => {
    const preview = jpegBytes();
    const sourceSha = 'a'.repeat(64);
    const previewSha = crypto.createHash('sha256').update(preview).digest('hex');
    const built = buildCommandEveImageVisionRequest({
      fileName: 'screenshot.png',
      fileSha256: sourceSha,
      imageSha256: previewSha,
      imageDataBase64: Buffer.from(preview).toString('base64'),
      locale: 'de-DE',
      privacyLane: 'cloud_auto',
      requestId: 'image-test-1',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toMatchObject({
      provider: 'openrouter',
      capability: 'vision',
      source_kind: 'image',
      directProviderKeyPresentInDesktop: false,
      file_name: 'screenshot.png',
      slide_count: 1,
    });
    expect(JSON.stringify(built.body)).not.toMatch(/api[_-]?key|sk-or-v1/i);

    const markdown = '## Image 1\n\nVisible screenshot evidence.';
    const parsed = parseCommandEveImageVisionResponse({
      ok: true,
      gateway: 'eve-multimodal',
      provider: 'openrouter',
      capability: 'vision',
      reason: 'provider-complete',
      artifact: {
        status: 'created',
        kind: 'text',
        mime_type: 'text/markdown',
        encoding: 'utf8',
        text: markdown,
        bytes: new TextEncoder().encode(markdown).byteLength,
      },
      residency: {
        requestedPrivacyLane: 'cloud_auto',
        effectiveResidency: 'global_cloud',
        confirmation: 'zdr-enforced-global',
      },
      vision: {
        source_kind: 'image',
        model: 'google/gemini-2.5-flash',
        file_sha256: sourceSha,
        slide_count: 1,
        slide_numbers: [1],
        image_count: 1,
        zdr_enforced: true,
        data_collection: 'deny',
      },
    });
    expect(parsed.ok).toBe(true);
  });

  it('blocks local-only egress and spoofed image receipts', () => {
    const preview = jpegBytes();
    expect(
      buildCommandEveImageVisionRequest({
        fileName: 'screenshot.png',
        fileSha256: 'a'.repeat(64),
        imageSha256: crypto.createHash('sha256').update(preview).digest('hex'),
        imageDataBase64: Buffer.from(preview).toString('base64'),
        locale: 'de-DE',
        privacyLane: 'local_only',
      })
    ).toMatchObject({ ok: false, reason_code: 'EVE_IMAGE_LOCAL_ONLY_PRIVACY' });
    expect(
      parseCommandEveImageVisionResponse({
        ok: true,
        gateway: 'eve-multimodal',
        provider: 'openrouter',
        capability: 'vision',
        reason: 'provider-complete',
        artifact: {
          status: 'created',
          kind: 'text',
          mime_type: 'text/markdown',
          encoding: 'utf8',
          text: '## Slide 1\n\nWrong boundary.',
          bytes: 28,
        },
        residency: {
          requestedPrivacyLane: 'cloud_auto',
          effectiveResidency: 'global_cloud',
          confirmation: 'zdr-enforced-global',
        },
        vision: {
          source_kind: 'presentation',
          model: 'model',
          file_sha256: 'a'.repeat(64),
          slide_count: 1,
          slide_numbers: [1],
          image_count: 1,
          zdr_enforced: true,
          data_collection: 'deny',
        },
      })
    ).toMatchObject({ ok: false, reason_code: 'EVE_IMAGE_RESPONSE_INVALID' });
  });

  it('creates a private image sidecar, reuses it by hash and preserves visible attachments', async () => {
    const root = temporaryRoot();
    const hermesHome = path.join(root, 'hermes');
    fs.mkdirSync(hermesHome, { mode: 0o700 });
    const sourcePath = path.join(root, 'screenshot.png');
    fs.writeFileSync(sourcePath, pngBytes());

    const inspection = inspectLocalImage({ filePath: sourcePath, hermesHome });
    expect(inspection.cachedDocument).toBeUndefined();
    const prepared = await prepareImageWithVision({
      inspection,
      hermesHome,
      locale: 'de-DE',
      requestId: 'image-preparation-test',
      normalizeImage: async () => jpegBytes(),
      analyze: async (input) => {
        expect(input.fileSha256).toBe(inspection.sha256);
        expect(input.image.mimeType).toBe('image/jpeg');
        return { markdown: '## Image 1\n\nA window with a visible chart.', model: 'google/gemini-2.5-flash' };
      },
    });
    expect(prepared.cache_hit).toBe(false);
    expect(prepared.prompt_context).toContain('## Image 1');
    expect(fs.statSync(prepared.sidecar_path).mode & 0o077).toBe(0);
    const sidecar = fs.readFileSync(prepared.sidecar_path, 'utf8');
    expect(sidecar).toContain('[Image 1]');
    expect(sidecar).toContain('untrusted document data');
    expect(mergeCommandEvePreparedImageFiles([sourcePath], [prepared])).toEqual([sourcePath, prepared.sidecar_path]);

    const cached = inspectLocalImage({ filePath: sourcePath, hermesHome });
    expect(cached.cachedDocument).toMatchObject({
      cache_hit: true,
      sidecar_path: prepared.sidecar_path,
      prompt_context: prepared.prompt_context,
    });
  });

  it('rejects symlink and extension-magic spoofing before cloud analysis', () => {
    const root = temporaryRoot();
    const hermesHome = path.join(root, 'hermes');
    fs.mkdirSync(hermesHome, { mode: 0o700 });
    const realPath = path.join(root, 'real.png');
    fs.writeFileSync(realPath, pngBytes());
    const linkPath = path.join(root, 'link.png');
    fs.symlinkSync(realPath, linkPath);
    expect(() => inspectLocalImage({ filePath: linkPath, hermesHome })).toThrowError(CommandEveImagePreparationError);

    const spoofed = path.join(root, 'spoofed.jpg');
    fs.writeFileSync(spoofed, pngBytes());
    expect(() => inspectLocalImage({ filePath: spoofed, hermesHome })).toThrowError(
      expect.objectContaining({ reasonCode: 'EVE_IMAGE_BAD_MAGIC' })
    );
  });
});
