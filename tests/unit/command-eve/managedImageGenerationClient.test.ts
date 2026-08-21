import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeManagedImageGenerationViaShim } from '@/common/chat/managedImageGenerationClient';
import {
  COMMAND_EVE_MANAGED_IMAGE_MODEL,
  COMMAND_EVE_MANAGED_IMAGE_PLATFORM,
} from '@/common/config/eveManagedImageGenerationCore';
import type { TProviderWithModel } from '@/common/config/storage';

const REQUEST_ID = 'c'.repeat(64);

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
    const sha256 = 'a'.repeat(64);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            created: 1,
            // 1.820.3 — the staged-handle shape: opaque reference + typed
            // metadata, deliberately NO b64_json on this wire.
            data: [
              {
                artifact_handle: `img_h_${'b'.repeat(64)}`,
                media_type: 'image/png',
                sha256,
                bytes_count: 15,
                workspace_relative_path: 'bilder/cover.png',
              },
            ],
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
        requestId: REQUEST_ID,
      })
    ).resolves.toMatchObject({
      ok: true,
      artifactHandle: `img_h_${'b'.repeat(64)}`,
      mediaType: 'image/png',
      sha256,
      bytesCount: 15,
      resolution: '1K',
      aspectRatio: '16:9',
      model: 'google/gemini-3-pro-image',
      costUsd: 0.12,
      workspaceRelativePath: 'bilder/cover.png',
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
      requestId: REQUEST_ID,
      input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2UtcmVmZXJlbmNl' } }],
    });
  });

  it('drops an unsafe workspace path instead of forwarding it to model-visible tool text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  artifact_handle: `img_h_${'b'.repeat(64)}`,
                  media_type: 'image/png',
                  sha256: 'a'.repeat(64),
                  bytes_count: 15,
                  workspace_relative_path: '/Users/alice/escape.png',
                },
              ],
            }),
            { status: 200 }
          )
      )
    );

    const result = await executeManagedImageGenerationViaShim({
      provider: provider(),
      prompt: 'direction',
      referenceDataUrls: [],
      requestId: REQUEST_ID,
    });

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && 'workspaceRelativePath' in result).toBe(false);
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

  it('refuses a missing Hermes request identity before the loopback call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      executeManagedImageGenerationViaShim({
        provider: provider(),
        prompt: 'direction',
        referenceDataUrls: [],
      })
    ).resolves.toEqual({ ok: false, error: 'Managed image request identity is missing.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a response without a staged reference or with incomplete metadata', async () => {
    // The pre-contract byte-bearing shape is REFUSED, not inflated: this client
    // exists only for the managed lane, and the managed lane carries no bytes.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=', media_type: 'image/png' }] }), {
            status: 200,
          })
      )
    );
    await expect(
      executeManagedImageGenerationViaShim({
        provider: provider(),
        prompt: 'direction',
        referenceDataUrls: [],
        requestId: REQUEST_ID,
      })
    ).resolves.toEqual({ ok: false, error: 'Managed image response did not contain an image reference.' });

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  artifact_handle: `img_h_${'b'.repeat(64)}`,
                  media_type: 'image/png',
                  sha256: 'nope',
                  bytes_count: 15,
                },
              ],
            }),
            { status: 200 }
          )
      )
    );
    await expect(
      executeManagedImageGenerationViaShim({
        provider: provider(),
        prompt: 'direction',
        referenceDataUrls: [],
        requestId: REQUEST_ID,
      })
    ).resolves.toEqual({ ok: false, error: 'Managed image response carried incomplete artifact metadata.' });
  });
});
