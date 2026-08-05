/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  readLicenseWire: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@/common/config/licenseWireAtRest', () => ({
  readLicenseWire: harness.readLicenseWire,
}));

import { readVideoCatalogWire, VIDEO_MODEL_CAPABILITIES_URL } from '@process/commandEve/videoCatalogWireMain';

const V1_RESPONSE = {
  version: 'command-eve-video-model-catalog/v1',
  enabled: true,
  gateway: 'openrouter',
  catalog_snapshot: '2026-08-05',
  models: [
    {
      id: 'minimax/hailuo-3',
      display_name: 'MiniMax: H3',
      resolutions: ['2K'],
      durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      aspect_ratios: ['16:9'],
      usd_per_second: { '2K': 0.13 },
      credits_per_second: { '2K': 260 },
    },
  ],
  unpriceable: [],
};

describe('readVideoCatalogWire (MAT-1773 F8b seam)', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('targets GET {eve-multimodal}/video-model-capabilities', () => {
    expect(VIDEO_MODEL_CAPABILITIES_URL).toBe(
      'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/eve-multimodal/video-model-capabilities'
    );
  });

  it('sends the license as a bearer and parses the v1 catalog view', async () => {
    harness.readLicenseWire.mockReturnValue({ ok: true, wire: 'ceve-license-wire' });
    harness.fetchMock.mockResolvedValue(
      new Response(JSON.stringify(V1_RESPONSE), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', harness.fetchMock);

    const entries = await readVideoCatalogWire('/tmp/userdata');

    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = harness.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(VIDEO_MODEL_CAPABILITIES_URL);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ceve-license-wire');
    expect(entries).toHaveLength(1);
    expect(entries![0]).toMatchObject({
      id: 'minimax/hailuo-3',
      displayName: 'MiniMax: H3',
      resolutions: ['2K'],
      usdPerSecond: { '2K': 0.13 },
      creditsPerSecond: { '2K': 260 },
    });
  });

  it('is self-quiet: no bearer, non-2xx and bad bodies all resolve to null', async () => {
    harness.readLicenseWire.mockReturnValue({ ok: false });
    expect(await readVideoCatalogWire('/tmp/userdata')).toBeNull();

    harness.readLicenseWire.mockReturnValue({ ok: true, wire: 'w' });
    harness.fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    vi.stubGlobal('fetch', harness.fetchMock);
    expect(await readVideoCatalogWire('/tmp/userdata')).toBeNull();

    harness.fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ version: 'v1', models: 'broken' }), { status: 200 })
    );
    expect(await readVideoCatalogWire('/tmp/userdata')).toBeNull();

    harness.fetchMock.mockRejectedValue(new Error('offline'));
    expect(await readVideoCatalogWire('/tmp/userdata')).toBeNull();
  });
});
