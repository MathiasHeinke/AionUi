import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeManagedImageGenerationViaShim } from '@/common/chat/managedImageGenerationClient';
import {
  COMMAND_EVE_MANAGED_IMAGE_MODEL,
  COMMAND_EVE_MANAGED_IMAGE_PLATFORM,
} from '@/common/config/eveManagedImageGenerationCore';
import type { TProviderWithModel } from '@/common/config/storage';

const provider = (baseUrl = 'http://127.0.0.1:41235/v1'): TProviderWithModel => ({
  id: 'command-eve-managed-image',
  name: 'EVE Visual Directions',
  platform: COMMAND_EVE_MANAGED_IMAGE_PLATFORM,
  base_url: baseUrl,
  api_key: 'local-process-nonce',
  use_model: COMMAND_EVE_MANAGED_IMAGE_MODEL,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('managed image generation loopback client', () => {
  it('posts one bounded direction to the authenticated loopback images endpoint', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            created: 1,
            data: [{ b64_json: Buffer.from('generated-image').toString('base64'), media_type: 'image/png' }],
            usage: { model: 'google/gemini-3-pro-image', cost: 0.12 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      executeManagedImageGenerationViaShim({
        provider: provider(),
        prompt: 'Create one restrained editorial presentation direction.',
        referenceDataUrls: ['data:image/png;base64,aW1hZ2UtcmVmZXJlbmNl'],
        aspectRatio: '16:9',
        resolution: '1K',
      })
    ).resolves.toMatchObject({
      ok: true,
      dataUrl: `data:image/png;base64,${Buffer.from('generated-image').toString('base64')}`,
      model: 'google/gemini-3-pro-image',
      costUsd: 0.12,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:41235/v1/images');
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer local-process-nonce' }),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: COMMAND_EVE_MANAGED_IMAGE_MODEL,
      prompt: 'Create one restrained editorial presentation direction.',
      n: 1,
      aspect_ratio: '16:9',
      resolution: '1K',
      input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2UtcmVmZXJlbmNl' } }],
    });
  });

  it('fails before fetch for remote URLs, missing nonces, or model drift', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      executeManagedImageGenerationViaShim({
        provider: provider('https://credential-sink.invalid/v1'),
        prompt: 'direction',
        referenceDataUrls: [],
      })
    ).resolves.toEqual({ ok: false, error: 'Managed image provider is not ready.' });
    await expect(
      executeManagedImageGenerationViaShim({
        provider: { ...provider(), api_key: '' },
        prompt: 'direction',
        referenceDataUrls: [],
      })
    ).resolves.toEqual({ ok: false, error: 'Managed image provider is not ready.' });
    await expect(
      executeManagedImageGenerationViaShim({
        provider: { ...provider(), use_model: 'remote-model' },
        prompt: 'direction',
        referenceDataUrls: [],
      })
    ).resolves.toEqual({ ok: false, error: 'Managed image provider is not ready.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized or malformed responses instead of treating them as images', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ b64_json: '%%%not-base64%%%', media_type: 'image/png' }] }), {
            status: 200,
          })
      )
    );

    await expect(
      executeManagedImageGenerationViaShim({ provider: provider(), prompt: 'direction', referenceDataUrls: [] })
    ).resolves.toEqual({ ok: false, error: 'Managed image response contained invalid image data.' });
  });
});
