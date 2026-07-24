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
import { executeCommandEveManagedImageGeneration } from '@/process/commandEve/managedImageGenerationService';

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
    });
    expect(JSON.stringify(init)).not.toContain('OPENROUTER_API_KEY');
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
      executeCommandEveManagedImageGeneration(request(), { fetchFn: fetchFn as typeof fetch, dataPath: '/tmp/test' })
    ).resolves.toMatchObject({
      status: 502,
      body: { error: { code: 'managed_image_receipt_mismatch' } },
    });
  });

  it('rejects an unknown model before reading the license or making a network call', async () => {
    const fetchFn = vi.fn();

    await expect(
      executeCommandEveManagedImageGeneration(
        { ...request(), model: 'remote-provider-model' },
        { fetchFn: fetchFn as typeof fetch, dataPath: '/tmp/test' }
      )
    ).resolves.toMatchObject({ status: 400, body: { error: { code: 'model_not_supported' } } });
    expect(readLicenseWireMock).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uses the active CEVE entitlement for every tier and fails closed when it is absent', async () => {
    readLicenseWireMock.mockReturnValueOnce({ ok: false, reason_code: 'LICENSE_WIRE_MISSING' });
    const fetchFn = vi.fn();

    await expect(
      executeCommandEveManagedImageGeneration(request(), { fetchFn: fetchFn as typeof fetch, dataPath: '/tmp/test' })
    ).resolves.toMatchObject({ status: 503, body: { error: { code: 'missing-license' } } });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
