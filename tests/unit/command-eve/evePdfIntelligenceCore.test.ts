/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildCommandEvePdfOcrRequest,
  mergeCommandEvePreparedPdfFiles,
  parseCommandEvePdfOcrResponse,
  type CommandEvePreparedPdfDocument,
} from '@/common/config/evePdfIntelligenceCore';

const sha256 = 'a'.repeat(64);
const pdfBase64 = Buffer.from('%PDF-1.7\nsmall').toString('base64');

describe('evePdfIntelligenceCore', () => {
  it('builds a server-only OpenRouter OCR request for the global cloud lane', () => {
    const result = buildCommandEvePdfOcrRequest({
      fileName: '/private/client.pdf',
      fileSha256: sha256,
      pageCount: 1,
      fileDataBase64: pdfBase64,
      privacyLane: 'cloud_auto',
      requestId: 'req-1',
    });

    expect(result).toEqual({
      ok: true,
      privacyLane: 'cloud_auto',
      body: {
        provider: 'openrouter',
        capability: 'document_ocr',
        privacyLane: 'cloud_auto',
        directProviderKeyPresentInDesktop: false,
        file_name: 'client.pdf',
        file_sha256: sha256,
        page_count: 1,
        file_data_base64: pdfBase64,
        requestId: 'req-1',
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/api[_-]?key|authorization/i);
  });

  it('blocks local, US, EU and DE claims rather than misrepresenting global routing', () => {
    for (const privacyLane of ['local_only', 'cloud_us', 'cloud_eu', 'cloud_de'] as const) {
      const result = buildCommandEvePdfOcrRequest({
        fileName: 'client.pdf',
        fileSha256: sha256,
        pageCount: 1,
        fileDataBase64: pdfBase64,
        privacyLane,
      });
      expect(result.ok).toBe(false);
    }
  });

  it('parses only a ZDR/data-deny document receipt and redacts failure messages', () => {
    const valid = parseCommandEvePdfOcrResponse({
      ok: true,
      gateway: 'eve-multimodal',
      provider: 'openrouter',
      capability: 'document_ocr',
      reason: 'provider-complete',
      artifact: {
        status: 'created',
        kind: 'document',
        mime_type: 'text/markdown',
        encoding: 'utf8',
        text: '## Page 1\nHello',
        bytes: 15,
      },
      residency: {
        requestedPrivacyLane: 'cloud_auto',
        effectiveResidency: 'global_cloud',
        confirmation: 'zdr-enforced-global',
      },
      document: {
        engine: 'mistral-ocr',
        model: 'google/gemini-2.5-flash',
        page_count: 1,
        zdr_enforced: true,
        data_collection: 'deny',
      },
    });
    expect(valid.ok).toBe(true);

    const invalid = parseCommandEvePdfOcrResponse({
      ok: true,
      gateway: 'eve-multimodal',
      provider: 'openrouter',
      capability: 'document_ocr',
      reason: 'provider-complete',
      artifact: { status: 'created', kind: 'document', mime_type: 'text/markdown', encoding: 'utf8', text: 'x' },
      residency: {
        requestedPrivacyLane: 'cloud_auto',
        effectiveResidency: 'global_cloud',
        confirmation: 'zdr-enforced-global',
      },
      document: { engine: 'mistral-ocr', model: 'm', page_count: 1, zdr_enforced: false, data_collection: 'allow' },
    });
    expect(invalid).toMatchObject({ ok: false, reason_code: 'EVE_PDF_OCR_BAD_BODY' });

    const failed = parseCommandEvePdfOcrResponse({
      ok: false,
      reason: 'provider-error',
      message: 'Bearer supersecretlongtokenvalue1234567890',
    });
    expect(failed).toMatchObject({ ok: false, message: 'Bearer [REDACTED]' });
  });

  it('keeps original PDFs and inserts deterministic citation sidecars once', () => {
    const document: CommandEvePreparedPdfDocument = {
      source_path: '/tmp/a.pdf',
      source_name: 'a.pdf',
      sha256,
      bytes: 100,
      page_count: 1,
      extracted_characters: 100,
      extraction_mode: 'local_text',
      sidecar_path: '/tmp/cache/document.md',
      citation_format: '[PDF p. N]',
      cache_hit: false,
    };
    expect(mergeCommandEvePreparedPdfFiles(['/tmp/a.pdf', '/tmp/b.txt'], [document])).toEqual([
      '/tmp/a.pdf',
      '/tmp/cache/document.md',
      '/tmp/b.txt',
    ]);
  });
});
