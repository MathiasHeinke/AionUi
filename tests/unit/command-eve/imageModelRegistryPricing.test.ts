import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  reserveBillableOperation,
  settleBillableOperation,
} from '../../../supabase/functions/_shared/billable-operations';
import { extractEveImageGenerationInput } from '../../../supabase/functions/eve-multimodal/image-generation-core';
import {
  imageModelCreditsPerImage,
  imageModelRetailEurCentsPerImage,
  imageRegistryFallbackActual,
  publicImageModelCapabilities,
  resolveImageGenerationModel,
} from '../../../supabase/functions/eve-multimodal/image-model-registry';

describe('server-owned image model reference pricing', () => {
  it('publishes the xAI fast tier as reference-capable with its per-reference surcharge', () => {
    const capabilities = publicImageModelCapabilities({ enabled: true });
    const fast = capabilities.tiers.find((tier) => tier.id === 'fast');

    expect(fast).toMatchObject({
      slug: 'x-ai/grok-imagine-image-quality',
      supports_references: true,
      quotes: {
        generate_credits: { '1K': 460, '2K': 644 },
        edit_credits: { '1K': 460, '2K': 644 },
        per_input_reference_credits: 92,
      },
    });
  });

  it('includes every accepted xAI reference in reserve and fallback pricing', () => {
    const fast = resolveImageGenerationModel('fast');
    expect(fast).not.toBeNull();

    expect(imageModelCreditsPerImage(fast!, '1K', 3)).toBe(736);
    expect(imageModelCreditsPerImage(fast!, '2K', 3)).toBe(920);
    expect(imageModelRetailEurCentsPerImage(fast!, '1K', 3)).toBe(73.6);
    expect(imageRegistryFallbackActual(fast!, '2K', 3)).toMatchObject({
      ok: true,
      rawEurCents: 9.2,
      retailEurCents: 92,
    });
  });

  it('fails closed above xAI’s images-route reference ceiling before debit', () => {
    const bytes = new TextEncoder().encode('reference-image');
    const reference = {
      mime_type: 'image/png',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      data_base64: btoa(String.fromCharCode(...bytes)),
    };
    const request = {
      prompt: 'Edit this image.',
      aspect_ratio: '1:1',
      resolution: '1K',
      image_model: 'fast',
    };

    expect(
      extractEveImageGenerationInput({ ...request, input_references: [reference, reference, reference] })
    ).not.toBe(null);
    expect(
      extractEveImageGenerationInput({ ...request, input_references: [reference, reference, reference, reference] })
    ).toBeNull();
  });

  it('routes provider refusal through the reserve reversal before responding', async () => {
    const indexSource = readFileSync(
      new URL('../../../supabase/functions/eve-multimodal/index.ts', import.meta.url),
      'utf8'
    );
    expect(indexSource).toMatch(
      /if \(!generated\.ok\) \{\s*return await refundAndRespond\(generated\.reason, generated\.message, generated\.status\);\s*\}/
    );

    let reversals = 0;
    const port = {
      commit: () =>
        Promise.resolve({
          status: 'applied' as const,
          entitlementId: '00000000-0000-4000-8000-000000000101',
          externalRef: 'image:xai-reference-refund',
        }),
      reverse: () => {
        reversals += 1;
        return Promise.resolve({ ok: true });
      },
    };
    const reserved = await reserveBillableOperation({
      port,
      operationId: 'multimodal.image_generation',
      tenantId: '00000000-0000-4000-8000-000000000001',
      externalRef: 'image:xai-reference-refund',
      model: 'x-ai/grok-imagine-image-quality',
      boundUnits: 1,
      explicitBoundRetailEurCents: 73.6,
    });
    expect(reserved.status).toBe('reserved');
    if (reserved.status !== 'reserved') throw new Error('reserve setup failed');

    const settled = await settleBillableOperation({
      port,
      receipt: reserved.receipt,
      actual: { ok: false, reason: 'provider-produced-nothing' },
      model: 'x-ai/grok-imagine-image-quality',
    });
    expect(settled).toEqual({ status: 'reversed', reason: 'provider-produced-nothing' });
    expect(reversals).toBe(1);
  });
});
