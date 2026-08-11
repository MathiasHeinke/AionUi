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
 * The 1.820.3 STAGE seam defaults to a spy returning a fixed staged handle, so
 * no test touches the private artifact store unless it means to.
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
    stageArtifact: vi.fn(() => ({ artifactHandle: `img_h_${'b'.repeat(64)}` })),
    ...overrides,
  };
}

const prompt = 'Create one cinematic but credible 16:9 presentation direction.';
const ACTIVE_SEED_ID = 'a2000000-0000-4000-8000-000000000001';
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
      getActiveSeatId: () => ACTIVE_SEED_ID,
      ...imageLaneSeams(),
    });

    // 1.820.3 — the response is PATH-FREE and BYTE-FREE: an opaque staged
    // handle plus typed metadata. No `b64_json` ever leaves this process.
    expect(result).toMatchObject({
      status: 200,
      body: {
        data: [
          {
            artifact_handle: `img_h_${'b'.repeat(64)}`,
            media_type: 'image/png',
            sha256: crypto.createHash('sha256').update(outputBytes).digest('hex'),
            bytes_count: outputBytes.length,
          },
        ],
        usage: { cost: 0.12, model: 'google/gemini-3-pro-image' },
      },
    });
    expect(JSON.stringify(result.body)).not.toContain('b64_json');
    expect(JSON.stringify(result.body)).not.toContain(outputBase64);
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
      seat_id: ACTIVE_SEED_ID,
    });
    expect(String(body.image_model)).not.toContain('/');
    expect(JSON.stringify(init)).not.toContain('OPENROUTER_API_KEY');
  });

  it('threads the seat’s SELECTED tier into the edge request as the bare tier id', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(edgeResponse()), { status: 200 }));
    // A GENERATION request (no references): the seat's choice travels as-is.
    const { input_references: _refs, ...generationRequest } = request();

    await executeCommandEveManagedImageGeneration(generationRequest, {
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

  it('1.820.3 edit authority: references ride the reference-capable tier for THIS request only, preference untouched', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(edgeResponse()), { status: 200 }));
    const maxPreference = vi.fn(async () => ({
      status: 'resolved' as const,
      tier: 'max' as const,
      source: 'stored_explicit' as const,
      seatId: 'seat-1',
      physicalKey: 'commandEve.imageModelPreference',
    }));

    // request() carries one reference — an EDIT. `max` is
    // supports_references=false and the edge would refuse it pre-debit, so
    // the service pins THIS request to the reference-capable tier (quality).
    await executeCommandEveManagedImageGeneration(request(), {
      fetchFn: fetchFn as typeof fetch,
      dataPath: '/tmp/test',
      ...imageLaneSeams({ readPreference: maxPreference }),
    });

    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body.image_model).toBe('quality');
    // The preference was READ, never WRITTEN: no persistence path was driven
    // — the next plain generation still bills the seat's own choice.
    expect(maxPreference).toHaveBeenCalledTimes(1);
  });

  it('1.820.3 edit authority: a fast-seat edit also resolves to the reference-capable tier', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(edgeResponse()), { status: 200 }));

    await executeCommandEveManagedImageGeneration(request(), {
      fetchFn: fetchFn as typeof fetch,
      dataPath: '/tmp/test',
      ...imageLaneSeams({
        readPreference: vi.fn(async () => ({
          status: 'resolved' as const,
          tier: 'fast' as const,
          source: 'stored_explicit' as const,
          seatId: 'seat-1',
          physicalKey: 'commandEve.imageModelPreference',
        })),
      }),
    });

    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body.image_model).toBe('quality');
  });

  it('1.820.3 edit authority: a quality-seat edit stays on quality (no override churn)', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(edgeResponse()), { status: 200 }));

    await executeCommandEveManagedImageGeneration(request(), {
      fetchFn: fetchFn as typeof fetch,
      dataPath: '/tmp/test',
      ...imageLaneSeams(),
    });

    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body.image_model).toBe('quality');
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

  it('1.820.3 STAGE: the verified bytes, tier and provenance reach the store — and a stage failure is named, never a fake success', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(edgeResponse()), { status: 200 }));
    const stageArtifact = vi.fn(() => ({ artifactHandle: `img_h_${'c'.repeat(64)}` }));

    const result = await executeCommandEveManagedImageGeneration(request(), {
      fetchFn: fetchFn as typeof fetch,
      dataPath: '/tmp/test',
      ...imageLaneSeams({ stageArtifact }),
      stagedParentArtifactId: 'img_parent123',
    });

    expect(result.status).toBe(200);
    expect(stageArtifact).toHaveBeenCalledTimes(1);
    const staged = stageArtifact.mock.calls[0][0] as Record<string, unknown>;
    // The bytes staged are EXACTLY the receipt-verified provider bytes — not
    // the base64 string, not a re-encode.
    expect(Buffer.from(staged.bytes as Uint8Array).equals(outputBytes)).toBe(true);
    expect(staged).toMatchObject({
      mimeType: 'image/png',
      tier: 'quality',
      model: 'google/gemini-3-pro-image',
      resolution: '1K',
      aspectRatio: '16:9',
      promptSha256: crypto.createHash('sha256').update(prompt).digest('hex'),
      parentArtifactId: 'img_parent123',
    });

    // A stage failure: the image was genuinely produced (and billed) upstream,
    // so the refusal names what happened instead of reporting a generation failure.
    const failingStage = vi.fn(() => undefined);
    await expect(
      executeCommandEveManagedImageGeneration(request(), {
        fetchFn: fetchFn as typeof fetch,
        dataPath: '/tmp/test',
        ...imageLaneSeams({ stageArtifact: failingStage }),
      })
    ).resolves.toMatchObject({ status: 502, body: { error: { code: 'managed_image_stage_failed' } } });
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
