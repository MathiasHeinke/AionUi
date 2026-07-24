import { describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_MANAGED_IMAGE_MODEL,
  COMMAND_EVE_MANAGED_IMAGE_PLATFORM,
  getCommandEveManagedImageProvider,
  parseCommandEveManagedImageEdgeResponse,
} from '@/common/config/eveManagedImageGenerationCore';

const bytes = Buffer.from('managed-image');
const base64 = bytes.toString('base64');
const sha256 = 'a'.repeat(64);

describe('managed image generation core', () => {
  it('defines a local-only synthetic provider without a remote provider key', () => {
    expect(getCommandEveManagedImageProvider()).toMatchObject({
      id: 'command-eve-managed-image',
      platform: COMMAND_EVE_MANAGED_IMAGE_PLATFORM,
      api_key: '',
      use_model: COMMAND_EVE_MANAGED_IMAGE_MODEL,
    });
  });

  it('accepts the exact server receipt and rejects base64 byte drift', () => {
    const raw = {
      ok: true,
      provider: 'openrouter',
      capability: 'image_generation',
      reason: 'provider-complete',
      artifact: {
        status: 'created',
        kind: 'image',
        mime_type: 'image/png',
        encoding: 'base64',
        data_base64: base64,
        bytes: bytes.length,
        sha256,
      },
      image_generation: {
        model: 'google/gemini-3-pro-image',
        prompt_sha256: 'b'.repeat(64),
        aspect_ratio: '16:9',
        resolution: '1K',
        input_reference_count: 1,
        input_reference_sha256: ['c'.repeat(64)],
        zdr_enforced: true,
        data_collection: 'deny',
        cost_usd: 0.12,
      },
      residency: {
        requestedPrivacyLane: 'cloud_auto',
        effectiveResidency: 'global_cloud',
        confirmation: 'zdr-enforced-global',
      },
    };

    expect(parseCommandEveManagedImageEdgeResponse(raw)).toMatchObject({ ok: true });
    expect(
      parseCommandEveManagedImageEdgeResponse({
        ...raw,
        artifact: { ...raw.artifact, bytes: bytes.length + 1 },
      })
    ).toEqual({ ok: false, reason_code: 'EVE_MANAGED_IMAGE_INVALID_ARTIFACT' });
  });

  it('preserves bounded provider failures without accepting fake success shapes', () => {
    expect(
      parseCommandEveManagedImageEdgeResponse({ ok: false, reason: 'image-generation-daily-cap', message: 'Cap.' })
    ).toEqual({ ok: false, reason_code: 'image-generation-daily-cap', message: 'Cap.' });
    expect(parseCommandEveManagedImageEdgeResponse({ ok: true })).toEqual({
      ok: false,
      reason_code: 'EVE_MANAGED_IMAGE_BAD_SUCCESS_SHAPE',
    });
  });
});
