/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIDEO_CATALOG_MODEL_ID,
  displayVideoCatalogName,
  estimateVideoCatalogCredits,
  formatVideoCatalogPrice,
  listVideoCatalogBeyondTopFive,
  parseVideoCatalogWire,
  resolveVideoCatalog,
  resolveVideoCatalogSelection,
  resolveVideoCatalogTopFive,
  VIDEO_CATALOG_SNAPSHOT,
  VIDEO_CATALOG_TOP5,
  type VideoCatalogEntry,
} from '@/common/config/videoCatalogCore';

const entry = (id: string, price: number, displayName?: string): VideoCatalogEntry => ({
  id,
  displayName: displayName ?? id,
  resolutions: ['720p'],
  durations: [5, 10],
  usdPerSecond: { '720p': price },
});

/** The real `command-eve-video-model-catalog/v1` response shape. */
const wireResponse = {
  version: 'command-eve-video-model-catalog/v1',
  enabled: true,
  gateway: 'openrouter',
  catalog_snapshot: '2026-08-05',
  models: [
    {
      id: 'x-ai/grok-imagine-video-1.5',
      display_name: 'SpaceXAI: Grok Imagine Video 1.5',
      resolutions: ['480p', '720p', '1080p'],
      durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      aspect_ratios: ['16:9'],
      usd_per_second: { '480p': 0.08, '720p': 0.14, '1080p': 0.25 },
      credits_per_second: { '480p': 160, '720p': 280, '1080p': 500 },
    },
    {
      id: 'runway/aleph-2',
      display_name: 'Runway: Aleph 2.0',
      resolutions: null,
      durations: null,
      aspect_ratios: ['16:9'],
      usd_per_second: { default: 0.28 },
      credits_per_second: { default: 560 },
    },
  ],
  unpriceable: [{ id: 'bytedance/seedance-2.0', reason: 'token-priced upstream' }],
};

describe('parseVideoCatalogWire (command-eve-video-model-catalog/v1)', () => {
  it('parses the served envelope with per-resolution price maps and bounds', () => {
    const parsed = parseVideoCatalogWire(wireResponse);

    expect(parsed).toHaveLength(2);
    expect(parsed![0]).toEqual({
      id: 'x-ai/grok-imagine-video-1.5',
      displayName: 'SpaceXAI: Grok Imagine Video 1.5',
      resolutions: ['480p', '720p', '1080p'],
      durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      aspectRatios: ['16:9'],
      usdPerSecond: { '480p': 0.08, '720p': 0.14, '1080p': 0.25 },
      creditsPerSecond: { '480p': 160, '720p': 280, '1080p': 500 },
    });
    // Resolution-flat: null bounds survive as null, price under the default key.
    expect(parsed![1].resolutions).toBeNull();
    expect(parsed![1].durations).toBeNull();
    expect(parsed![1].usdPerSecond).toEqual({ default: 0.28 });
  });

  it('drops individually-bad rows and rejects unusable payloads', () => {
    const parsed = parseVideoCatalogWire({
      models: [
        { id: 'google/veo-3.1', display_name: 'Google: Veo 3.1', usd_per_second: { '720p': 0.4 } },
        { id: '', display_name: 'broken', usd_per_second: { '720p': 0.1 } },
        { id: 'no-price', display_name: 'No price' },
        'garbage',
      ],
    });
    expect(parsed).toEqual([
      {
        id: 'google/veo-3.1',
        displayName: 'Google: Veo 3.1',
        resolutions: null,
        durations: null,
        usdPerSecond: { '720p': 0.4 },
      },
    ]);

    expect(parseVideoCatalogWire(null)).toBeNull();
    expect(parseVideoCatalogWire({})).toBeNull();
    expect(parseVideoCatalogWire({ models: 'nope' })).toBeNull();
    expect(parseVideoCatalogWire([{ id: 'x', display_name: 'y', usd_per_second: { '720p': -1 } }])).toBeNull();
  });
});

describe('resolveVideoCatalog', () => {
  it('prefers live entries and marks the fallback approximate', () => {
    const live = resolveVideoCatalog([entry('a/b', 0.2)]);
    expect(live.source).toBe('live');
    expect(live.approximate).toBe(false);

    const fallback = resolveVideoCatalog(null);
    expect(fallback.source).toBe('fallback');
    expect(fallback.approximate).toBe(true);
    expect(fallback.entries).toBe(VIDEO_CATALOG_SNAPSHOT);
  });
});

describe('the bundled snapshot (mirror of the server 2026-08-05 view)', () => {
  it('carries the 18 priceable models — the token-priced Seedance trio stays out', () => {
    expect(VIDEO_CATALOG_SNAPSHOT).toHaveLength(18);
    expect(VIDEO_CATALOG_SNAPSHOT.find((e) => e.id.startsWith('bytedance/seedance'))).toBeUndefined();
  });

  it('has MiniMax H3 at $0.13/s — cheap, but NOT the cheapest upstream', () => {
    // Founder expectation was "H3 0,13 first"; the resolved 2026-08-05 catalog
    // undercuts it (Grok base and Veo 3.1 Lite both start at $0.05/s). The
    // snapshot mirrors server truth, not the expectation.
    const hailuo = VIDEO_CATALOG_SNAPSHOT.find((e) => e.id === 'minimax/hailuo-3')!;
    expect(hailuo.usdPerSecond['2K']).toBe(0.13);
    const cheapestBase = Math.min(...VIDEO_CATALOG_SNAPSHOT.map((e) => Math.min(...Object.values(e.usdPerSecond))));
    expect(cheapestBase).toBe(0.05);
  });

  it('mirrors the server figures for Grok Imagine Video 1.5 exactly', () => {
    const grok = VIDEO_CATALOG_SNAPSHOT.find((e) => e.id === DEFAULT_VIDEO_CATALOG_MODEL_ID)!;
    expect(grok.resolutions).toEqual(['480p', '720p', '1080p']);
    expect(grok.durations).toHaveLength(15);
    expect(grok.usdPerSecond).toEqual({ '480p': 0.08, '720p': 0.14, '1080p': 0.25 });
    expect(grok.creditsPerSecond).toEqual({ '480p': 160, '720p': 280, '1080p': 500 });
  });
});

describe('resolveVideoCatalogTopFive', () => {
  it('keeps the curated order and skips what the catalog cannot price', () => {
    const top = resolveVideoCatalogTopFive(VIDEO_CATALOG_SNAPSHOT);
    // Seedance 2.0 is token-priced upstream: four shown, never with an invented price.
    expect(top.map((e) => e.id)).toEqual([
      'x-ai/grok-imagine-video-1.5',
      'google/veo-3.1',
      'openai/sora-2-pro',
      'black-forest-labs/flux-3-video',
    ]);
    expect(top[0].id).toBe(DEFAULT_VIDEO_CATALOG_MODEL_ID);
    expect(VIDEO_CATALOG_TOP5).toHaveLength(5);
  });

  it('matches on the display name when the server qualifies ids differently', () => {
    const renamed = [entry('or/x-ai-grok-imagine-video-1.5', 0.32, 'Grok Imagine Video 1.5')];
    expect(resolveVideoCatalogTopFive(renamed).map((e) => e.displayName)).toEqual(['Grok Imagine Video 1.5']);
  });
});

describe('displayVideoCatalogName', () => {
  it('uses the curated spelling for TOP-5 entries and de-colonises the rest', () => {
    const flux = VIDEO_CATALOG_SNAPSHOT.find((e) => e.id === 'black-forest-labs/flux-3-video')!;
    expect(displayVideoCatalogName(flux)).toBe('FLUX.3 Video');
    const hailuo = VIDEO_CATALOG_SNAPSHOT.find((e) => e.id === 'minimax/hailuo-3')!;
    expect(displayVideoCatalogName(hailuo)).toBe('MiniMax H3');
  });
});

describe('listVideoCatalogBeyondTopFive', () => {
  it('returns the rest sorted by base USD/second ascending, cheapest first', () => {
    const beyond = listVideoCatalogBeyondTopFive(VIDEO_CATALOG_SNAPSHOT);
    expect(beyond).toHaveLength(VIDEO_CATALOG_SNAPSHOT.length - 4);
    // The cheapest base rate upstream is the Grok base model ($0.05/s).
    expect(beyond[0].id).toBe('x-ai/grok-imagine-video');
    const prices = beyond.map((e) => Math.min(...Object.values(e.usdPerSecond)));
    expect(prices.toSorted((a, b) => a - b)).toEqual(prices);
  });

  it('DEDUPE (1.820.5): never lists a curated model twice, even through a display-name match', () => {
    // A server that qualifies the id differently than the curated spec — the
    // top-five matches it by NAME, and the beyond-list must still exclude it.
    const aliased = entry('or/x-ai-grok-imagine-video-1.5', 0.32, 'Grok Imagine Video 1.5');
    const beyond = listVideoCatalogBeyondTopFive([aliased, entry('minimax/hailuo-3', 0.13)]);
    expect(resolveVideoCatalogTopFive([aliased, entry('minimax/hailuo-3', 0.13)])).toHaveLength(1);
    expect(beyond.map((e) => e.id)).toEqual(['minimax/hailuo-3']);
  });

  it('DEDUPE: no snapshot entry appears in both the shortlist and the beyond-list', () => {
    const top = resolveVideoCatalogTopFive(VIDEO_CATALOG_SNAPSHOT);
    const beyond = listVideoCatalogBeyondTopFive(VIDEO_CATALOG_SNAPSHOT);
    for (const curated of top) {
      expect(beyond.find((e) => e.id === curated.id)).toBeUndefined();
    }
  });
});

describe('resolveVideoCatalogSelection (invalid combinations become unselectable)', () => {
  const flux = VIDEO_CATALOG_SNAPSHOT.find((e) => e.id === 'black-forest-labs/flux-3-video')!;
  const grok = VIDEO_CATALOG_SNAPSHOT.find((e) => e.id === 'x-ai/grok-imagine-video-1.5')!;
  const aleph = VIDEO_CATALOG_SNAPSHOT.find((e) => e.id === 'runway/aleph-2')!;
  const veo = VIDEO_CATALOG_SNAPSHOT.find((e) => e.id === 'google/veo-3.1')!;

  it('keeps supported values untouched', () => {
    expect(resolveVideoCatalogSelection({ entry: grok, resolution: '720p', durationSeconds: 10 })).toEqual({
      resolution: '720p',
      durationSeconds: 10,
      resolutionAdjusted: false,
      durationAdjusted: false,
    });
  });

  it('auto-picks the NEAREST supported resolution and flags the change', () => {
    // FLUX has no 480p: 480p -> 720p (nearest), flagged.
    expect(resolveVideoCatalogSelection({ entry: flux, resolution: '480p', durationSeconds: 5 })).toEqual({
      resolution: '720p',
      durationSeconds: 5,
      resolutionAdjusted: true,
      durationAdjusted: false,
    });
    // 4K on FLUX -> 1080p (nearest below).
    expect(resolveVideoCatalogSelection({ entry: flux, resolution: '4K', durationSeconds: 5 }).resolution).toBe(
      '1080p'
    );
  });

  it('auto-picks the nearest supported duration, tie-break to the lower value', () => {
    // Veo offers 4/6/8: 15s -> 8s, 5s -> 4s (tie 4|6 -> lower).
    expect(resolveVideoCatalogSelection({ entry: veo, resolution: '720p', durationSeconds: 15 })).toEqual({
      resolution: '720p',
      durationSeconds: 8,
      resolutionAdjusted: false,
      durationAdjusted: true,
    });
    expect(resolveVideoCatalogSelection({ entry: veo, resolution: '720p', durationSeconds: 5 }).durationSeconds).toBe(
      4
    );
  });

  it('treats null bounds as unconstrained (resolution-flat model)', () => {
    expect(resolveVideoCatalogSelection({ entry: aleph, resolution: '720p', durationSeconds: 7 })).toEqual({
      resolution: null,
      durationSeconds: 7,
      resolutionAdjusted: false,
      durationAdjusted: false,
    });
  });

  it('defaults to the cheapest supported resolution when nothing is requested', () => {
    expect(resolveVideoCatalogSelection({ entry: flux, durationSeconds: 5 }).resolution).toBe('720p');
  });
});

describe('estimateVideoCatalogCredits', () => {
  const grok = VIDEO_CATALOG_SNAPSHOT.find((e) => e.id === 'x-ai/grok-imagine-video-1.5')!;
  const flux = VIDEO_CATALOG_SNAPSHOT.find((e) => e.id === 'black-forest-labs/flux-3-video')!;
  const aleph = VIDEO_CATALOG_SNAPSHOT.find((e) => e.id === 'runway/aleph-2')!;
  const happyhorse = VIDEO_CATALOG_SNAPSHOT.find((e) => e.id === 'alibaba/happyhorse-1.1')!;

  it('prices the exact model x resolution x duration combination', () => {
    // Grok 720p 5s: 280 credits/s -> 1400 (matches the legacy table the send uses).
    expect(estimateVideoCatalogCredits({ entry: grok, resolution: '720p', durationSeconds: 5 })).toEqual({
      credits: 1400,
      usdPerSecond: 0.14,
      creditsPerSecond: 280,
    });
    // FLUX 1080p 20s: 580 credits/s -> 11600.
    expect(estimateVideoCatalogCredits({ entry: flux, resolution: '1080p', durationSeconds: 20 })?.credits).toBe(11600);
    // Resolution-flat Aleph 2: the default key, 560 credits/s -> 8s = 4480.
    expect(estimateVideoCatalogCredits({ entry: aleph, resolution: null, durationSeconds: 8 })?.credits).toBe(4480);
  });

  it('never rounds sub-cent prices DOWN (0.0988/s -> 200 credits/s, not 198)', () => {
    const estimate = estimateVideoCatalogCredits({ entry: happyhorse, resolution: '720p', durationSeconds: 5 });
    expect(estimate?.creditsPerSecond).toBe(200);
    expect(estimate?.credits).toBe(1000);
  });
});

describe('formatVideoCatalogPrice', () => {
  it('renders the German decimal comma and keeps sub-cent precision', () => {
    expect(formatVideoCatalogPrice(0.13)).toBe('0,13 $/s');
    expect(formatVideoCatalogPrice(0.5)).toBe('0,5 $/s');
    expect(formatVideoCatalogPrice(0.0988)).toBe('0,0988 $/s');
  });
});
