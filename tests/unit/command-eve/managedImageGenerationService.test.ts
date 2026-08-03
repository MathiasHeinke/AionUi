import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readLicenseWireMock } = vi.hoisted(() => ({
  readLicenseWireMock: vi.fn(() => ({ ok: true, wire: 'CEVE.v2.test-wire' })),
}));

vi.mock('@/common/config/licenseWireAtRest', () => ({
  readLicenseWire: (...args: unknown[]) => readLicenseWireMock(...args),
}));

import { COMMAND_EVE_MANAGED_IMAGE_MODEL } from '@/common/config/eveManagedImageGenerationCore';
import { EVE_MULTIMODAL_FUNCTION_URL } from '@/common/config/eveMultimodalGatewayCore';
import type { CommandEveImageModelRegistry } from '@/common/config/eveImageModelRegistryCore';
import { executeCommandEveManagedImageGeneration } from '@/process/commandEve/managedImageGenerationService';

/** The server-pinned registry view (MAT-1769, CoS contract), as the GET read answers. */
const REGISTRY: CommandEveImageModelRegistry = {
  version: 'command-eve-image-model-registry/v1',
  enabled: true,
  default_tier: 'quality',
  tiers: [
    {
      id: 'fast',
      slug: 'x-ai/grok-imagine-image-quality',
      display_name: 'Schnell',
      premium: false,
      supports_references: false,
      resolutions: ['1K', '2K'],
      quotes: {
        generate_credits: { '1K': 460, '2K': 460 },
        edit_credits: { '1K': 460, '2K': 460 },
        per_input_reference_credits: 0,
      },
    },
    {
      id: 'quality',
      slug: 'google/gemini-3.1-flash-image',
      display_name: 'Nano Banana 2',
      premium: false,
      supports_references: true,
      resolutions: ['1K', '2K'],
      quotes: {
        generate_credits: { '1K': 1380, '2K': 1380 },
        edit_credits: { '1K': 1380, '2K': 1380 },
        per_input_reference_credits: 0,
      },
    },
    {
      id: 'max',
      slug: 'openai/gpt-image-2',
      display_name: 'GPT Image 2',
      premium: true,
      supports_references: false,
      resolutions: ['1K', '2K'],
      quotes: {
        generate_credits: { '1K': 2300, '2K': 2300 },
        edit_credits: { '1K': 2300, '2K': 2300 },
        per_input_reference_credits: 0,
      },
    },
  ],
};

/**
 * The MAT-1769 seams, injected so no test depends on seat settings or a second
 * network surface. Default: a stored-quality seat against the full registry.
 */
function imageLaneSeams(overrides: Record<string, unknown> = {}) {
  return {
    readPreference: vi.fn(async () => ({
      status: 'resolved' as const,
      tier: 'quality' as const,
      source: 'product_default' as const,
      seatId: 'seat-1',
      physicalKey: 'commandEve.imageModelPreference',
    })),
    readRegistry: vi.fn(async () => ({ ok: true as const, registry: REGISTRY })),
    ...overrides,
  };
}

const prompt = 'Create one cinematic but credible 16:9 presentation direction.';
const referenceBytes = Buffer.from('reference-image');
const referenceBase64 = referenceBytes.toString('base64');
const outputBytes = Buffer.from('generated-image');
const outputBase64 = outputBytes.toString('base64');

function edgeResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    provider: 'openrouter',
    capability: 'image_generation',
    reason: 'provider-complete',
    artifact: {
      status: 'created',
      kind: 'image',
      mime_type: 'image/png',
      encoding: 'base64',
      data_base64: outputBase64,
      bytes: outputBytes.length,
      sha256: crypto.createHash('sha256').update(outputBytes).digest('hex'),
    },
    image_generation: {
      model: 'google/gemini-3-pro-image',
      prompt_sha256: crypto.createHash('sha256').update(prompt).digest('hex'),
      aspect_ratio: '16:9',
      resolution: '1K',
      input_reference_count: 1,
      input_reference_sha256: [crypto.createHash('sha256').update(referenceBytes).digest('hex')],
      zdr_enforced: true,
      data_collection: 'deny',
      cost_usd: 0.12,
    },
    residency: {
      requestedPrivacyLane: 'cloud_auto',
      effectiveResidency: 'global_cloud',
      confirmation: 'zdr-enforced-global',
    },
    ...overrides,
  };
}

function request() {
  return {
    model: COMMAND_EVE_MANAGED_IMAGE_MODEL,
    prompt,
    n: 1,
    aspect_ratio: '16:9',
    resolution: '1K',
    input_references: [
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${referenceBase64}` },
      },
    ],
  };
}

beforeEach(() => {
  readLicenseWireMock.mockReset();
  readLicenseWireMock.mockReturnValue({ ok: true, wire: 'CEVE.v2.test-wire' });
});

describe('managed image generation main-process service', () => {
  it('forwards only the CEVE bearer and bounded image contract to the server gateway', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(edgeResponse()), { status: 200 }));

    const result = await executeCommandEveManagedImageGeneration(request(), {
      fetchFn: fetchFn as typeof fetch,
      dataPath: '/tmp/eve-managed-image-test',
      ...imageLaneSeams(),
    });

    expect(result).toMatchObject({
      status: 200,
      body: {
        data: [{ b64_json: outputBase64, media_type: 'image/png' }],
        usage: { cost: 0.12, model: 'google/gemini-3-pro-image' },
      },
    });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(EVE_MULTIMODAL_FUNCTION_URL);
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer CEVE.v2.test-wire' }),
      redirect: 'error',
      cache: 'no-store',
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      provider: 'openrouter',
      capability: 'image_generation',
      privacyLane: 'cloud_auto',
      directProviderKeyPresentInDesktop: false,
      prompt,
      aspect_ratio: '16:9',
      resolution: '1K',
      // MAT-1769 (CoS contract): the seat's tier as the BARE TIER ID. The
      // shim-facing `model` stays command-eve-visual-direction-v1, and the
      // slug never travels — the server owns tier → slug.
      image_model: 'quality',
    });
    expect(String(body.image_model)).not.toContain('/');
    expect(JSON.stringify(init)).not.toContain('OPENROUTER_API_KEY');
  });

  it('threads the seat’s SELECTED tier into the edge request as the bare tier id', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(edgeResponse()), { status: 200 }));

    await executeCommandEveManagedImageGeneration(request(), {
      fetchFn: fetchFn as typeof fetch,
      dataPath: '/tmp/test',
      ...imageLaneSeams({
        readPreference: vi.fn(async () => ({
          status: 'resolved' as const,
          tier: 'max' as const,
          source: 'stored_explicit' as const,
          seatId: 'seat-1',
          physicalKey: 'commandEve.imageModelPreference',
        })),
      }),
    });

    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body.image_model).toBe('max');
  });

  it('falls back to the registry’s default tier when the preference cannot be read', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(edgeResponse()), { status: 200 }));

    await executeCommandEveManagedImageGeneration(request(), {
      fetchFn: fetchFn as typeof fetch,
      dataPath: '/tmp/test',
      ...imageLaneSeams({
        readPreference: vi.fn(async () => ({
          status: 'unavailable' as const,
          reason: 'settings_read_failed' as const,
        })),
      }),
    });

    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body.image_model).toBe('quality');
  });

  it('refuses closed when the gateway lane is disabled — no model, no POST', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(edgeResponse()), { status: 200 }));

    await expect(
      executeCommandEveManagedImageGeneration(request(), {
        fetchFn: fetchFn as typeof fetch,
        dataPath: '/tmp/test',
        ...imageLaneSeams({
          readRegistry: vi.fn(async () => ({ ok: true as const, registry: { ...REGISTRY, enabled: false } })),
        }),
      })
    ).resolves.toMatchObject({ status: 503, body: { error: { code: 'image_generation_disabled' } } });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses closed when the registry is unavailable — never a hardcoded fallback model', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(edgeResponse()), { status: 200 }));

    await expect(
      executeCommandEveManagedImageGeneration(request(), {
        fetchFn: fetchFn as typeof fetch,
        dataPath: '/tmp/test',
        ...imageLaneSeams({
          readRegistry: vi.fn(async () => ({ ok: false as const, reason: 'capabilities_timeout' as const })),
        }),
      })
    ).resolves.toMatchObject({ status: 503, body: { error: { code: 'image_model_registry_unavailable' } } });
    // The generation POST must not happen: no verified mapping, no billing.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses closed when the selected tier is not in the server registry', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(edgeResponse()), { status: 200 }));
    const withoutQuality: CommandEveImageModelRegistry = {
      ...REGISTRY,
      tiers: REGISTRY.tiers.filter((tier) => tier.id !== 'quality'),
    };

    await expect(
      executeCommandEveManagedImageGeneration(request(), {
        fetchFn: fetchFn as typeof fetch,
        dataPath: '/tmp/test',
        ...imageLaneSeams({
          readRegistry: vi.fn(async () => ({ ok: true as const, registry: withoutQuality })),
        }),
      })
    ).resolves.toMatchObject({ status: 503, body: { error: { code: 'image_model_tier_unavailable' } } });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fails closed when the returned receipt does not match the requested prompt', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            edgeResponse({
              image_generation: {
                ...edgeResponse().image_generation,
                prompt_sha256: 'f'.repeat(64),
              },
            })
          ),
          { status: 200 }
        )
    );

    await expect(
      executeCommandEveManagedImageGeneration(request(), {
        fetchFn: fetchFn as typeof fetch,
        dataPath: '/tmp/test',
        ...imageLaneSeams(),
      })
    ).resolves.toMatchObject({
      status: 502,
      body: { error: { code: 'managed_image_receipt_mismatch' } },
    });
  });

  it('rejects an unknown model before reading the license, the registry, or making a network call', async () => {
    const fetchFn = vi.fn();
    const seams = imageLaneSeams();

    await expect(
      executeCommandEveManagedImageGeneration(
        { ...request(), model: 'remote-provider-model' },
        { fetchFn: fetchFn as typeof fetch, dataPath: '/tmp/test', ...seams }
      )
    ).resolves.toMatchObject({ status: 400, body: { error: { code: 'model_not_supported' } } });
    expect(readLicenseWireMock).not.toHaveBeenCalled();
    expect(seams.readPreference).not.toHaveBeenCalled();
    expect(seams.readRegistry).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uses the active CEVE entitlement for every tier and fails closed when it is absent', async () => {
    readLicenseWireMock.mockReturnValueOnce({ ok: false, reason_code: 'LICENSE_WIRE_MISSING' });
    const fetchFn = vi.fn();
    const seams = imageLaneSeams();

    await expect(
      executeCommandEveManagedImageGeneration(request(), {
        fetchFn: fetchFn as typeof fetch,
        dataPath: '/tmp/test',
        ...seams,
      })
    ).resolves.toMatchObject({ status: 503, body: { error: { code: 'missing-license' } } });
    expect(seams.readRegistry).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
