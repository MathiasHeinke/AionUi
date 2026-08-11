/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildCommandEveAttachmentGroundingRequest,
  groundingExpectationFromImage,
  groundingExpectationFromPdf,
  normalizeCommandEveAttachmentGroundingRequest,
  validateCommandEveAttachmentGroundingReceipt,
} from '@/common/config/eveAttachmentGroundingCore';

describe('Command EVE attachment grounding receipt', () => {
  const pdf = groundingExpectationFromPdf({
    source_path: '/tmp/brief.pdf',
    source_name: 'brief.pdf',
    sha256: 'a'.repeat(64),
    bytes: 100,
    page_count: 1,
    extracted_characters: 20,
    extraction_mode: 'local_text',
    sidecar_path: '/tmp/document-intelligence/pdf/a/document.md',
    sidecar_sha256: 'b'.repeat(64),
    sidecar_bytes: 80,
    citation_format: '[PDF p. N]',
    cache_hit: false,
  });
  const image = groundingExpectationFromImage({
    source_path: '/tmp/image.png',
    source_name: 'image.png',
    sha256: 'c'.repeat(64),
    bytes: 200,
    extraction_mode: 'cloud_vision',
    sidecar_path: '/tmp/document-intelligence/image/c/document.md',
    sidecar_sha256: 'd'.repeat(64),
    sidecar_bytes: 90,
    prompt_context: '## Image 1\nVerified.',
    citation_format: '[Image 1]',
    model: 'curated-vision-model',
    cache_hit: false,
  });

  it('builds and round-trips an exact PDF/image request', () => {
    const request = buildCommandEveAttachmentGroundingRequest([pdf, image]);
    expect(request).toEqual({
      version: 'command-eve-attachment-grounding/v1',
      entries: [pdf, image],
    });
    expect(normalizeCommandEveAttachmentGroundingRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });

  it('accepts only a byte-identical, embedded server receipt', () => {
    const request = buildCommandEveAttachmentGroundingRequest([pdf, image]);
    const receipt = {
      version: 'command-eve-attachment-grounding-receipt/v1',
      status: 'accepted',
      entries: [pdf, image].map((entry) => ({ ...entry, grounding_embedded: true })),
    };
    expect(validateCommandEveAttachmentGroundingReceipt(request, receipt)).toEqual(receipt);
    expect(
      validateCommandEveAttachmentGroundingReceipt(request, {
        ...receipt,
        entries: [{ ...receipt.entries[0], grounding_sha256: 'f'.repeat(64) }, receipt.entries[1]],
      })
    ).toBeNull();
    expect(
      validateCommandEveAttachmentGroundingReceipt(request, {
        ...receipt,
        entries: receipt.entries.map(({ grounding_embedded: _embedded, ...entry }) => entry),
      })
    ).toBeNull();
  });

  it('fails closed above the bounded Hermes sidecar ceiling', () => {
    expect(buildCommandEveAttachmentGroundingRequest([{ ...pdf, grounding_bytes: 512 * 1024 + 1 }])).toBeUndefined();
  });
});
