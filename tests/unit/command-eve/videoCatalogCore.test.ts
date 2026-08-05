/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIDEO_CATALOG_MODEL_ID,
  estimateVideoCatalogCredits,
  formatVideoCatalogPrice,
  listVideoCatalogBeyondTopFive,
  parseVideoCatalogWire,
  resolveVideoCatalog,
  resolveVideoCatalogTopFive,
  VIDEO_CATALOG_SNAPSHOT,
  VIDEO_CATALOG_TOP5,
  type VideoCatalogEntry,
} from '@/common/config/videoCatalogCore';

const entry = (id: string, price: number, displayName?: string): VideoCatalogEntry => ({
  id,
  displayName: displayName ?? id,
  pricePerSecondUsd: price,
});

describe('parseVideoCatalogWire', () => {
  it('parses a bare array with snake_case fields', () => {
    const parsed = parseVideoCatalogWire([
      {
        id: 'x-ai/grok-imagine-video-1.5',
        display_name: 'Grok Imagine Video 1.5',
        price_per_second_usd: 0.14,
        resolutions: ['480p', '720p', '1080p', '4k'],
        max_duration_seconds: 15,
        prices_by_resolution: { '720p': 0.14, bogus: 'x' },
      },
    ]);

    expect(parsed).toEqual([
      {
        id: 'x-ai/grok-imagine-video-1.5',
        displayName: 'Grok Imagine Video 1.5',
        pricePerSecondUsd: 0.14,
        pricesByResolution: { '720p': 0.14 },
        resolutions: ['480p', '720p', '1080p'],
        maxDurationSeconds: 15,
      },
    ]);
  });

  it('parses the wrapper shape and drops individually-bad rows', () => {
    const parsed = parseVideoCatalogWire({
      video_catalog: [
        { id: 'google/veo-3.1', name: 'Google Veo 3.1', price_per_second_usd: 0.5 },
        { id: '', name: 'broken', price_per_second_usd: 0.1 },
        { id: 'no-price', name: 'No price' },
        'garbage',
      ],
    });

    expect(parsed).toEqual([{ id: 'google/veo-3.1', displayName: 'Google Veo 3.1', pricePerSecondUsd: 0.5 }]);
  });

  it('returns null for anything without a usable catalog', () => {
    expect(parseVideoCatalogWire(null)).toBeNull();
    expect(parseVideoCatalogWire(undefined)).toBeNull();
    expect(parseVideoCatalogWire({})).toBeNull();
    expect(parseVideoCatalogWire([])).toBeNull();
    expect(parseVideoCatalogWire({ video_catalog: 'nope' })).toBeNull();
    expect(parseVideoCatalogWire([{ id: 'x', name: 'y', price_per_second_usd: -1 }])).toBeNull();
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

describe('the bundled snapshot', () => {
  it('carries all 21 models with MiniMax Hailuo 3 as the cheapest', () => {
    expect(VIDEO_CATALOG_SNAPSHOT).toHaveLength(21);
    const cheapest = [...VIDEO_CATALOG_SNAPSHOT].toSorted((a, b) => a.pricePerSecondUsd - b.pricePerSecondUsd)[0];
    expect(cheapest.id).toBe('minimax/hailuo-3');
    expect(cheapest.pricePerSecondUsd).toBe(0.13);
  });

  it('covers every curated TOP-5 model and keeps Grok Imagine Video 1.5 the default', () => {
    const top = resolveVideoCatalogTopFive(VIDEO_CATALOG_SNAPSHOT);
    expect(top.map((e) => e.id)).toEqual(VIDEO_CATALOG_TOP5.map((c) => c.id));
    expect(top[0].id).toBe(DEFAULT_VIDEO_CATALOG_MODEL_ID);
    expect(top[0].displayName).toBe('Grok Imagine Video 1.5');
  });
});

describe('resolveVideoCatalogTopFive', () => {
  it('keeps the curated order, never the catalog order', () => {
    const shuffled = [
      entry('bytedance/seedance-2.0', 0.38),
      entry('openai/sora-2-pro', 0.6),
      entry('x-ai/grok-imagine-video-1.5', 0.32),
      entry('google/veo-3.1', 0.5),
      entry('black-forest-labs/flux-3-video', 0.48),
    ];
    expect(resolveVideoCatalogTopFive(shuffled).map((e) => e.id)).toEqual([
      'x-ai/grok-imagine-video-1.5',
      'google/veo-3.1',
      'openai/sora-2-pro',
      'black-forest-labs/flux-3-video',
      'bytedance/seedance-2.0',
    ]);
  });

  it('matches on the display name when the server qualifies ids differently', () => {
    const renamed = [entry('or/x-ai-grok-imagine-video-1.5', 0.32, 'Grok Imagine Video 1.5')];
    const top = resolveVideoCatalogTopFive(renamed);
    expect(top).toHaveLength(1);
    expect(top[0].displayName).toBe('Grok Imagine Video 1.5');
  });

  it('skips curated models the catalog does not carry', () => {
    expect(resolveVideoCatalogTopFive([entry('minimax/hailuo-3', 0.13)])).toEqual([]);
  });
});

describe('listVideoCatalogBeyondTopFive', () => {
  it('returns the rest sorted by USD/second ascending, cheapest first', () => {
    const beyond = listVideoCatalogBeyondTopFive(VIDEO_CATALOG_SNAPSHOT);
    expect(beyond).toHaveLength(VIDEO_CATALOG_SNAPSHOT.length - 5);
    expect(beyond[0].id).toBe('minimax/hailuo-3');
    const prices = beyond.map((e) => e.pricePerSecondUsd);
    expect([...prices].toSorted((a, b) => a - b)).toEqual(prices);
    // No TOP-5 id survives into the expansion list.
    for (const curated of VIDEO_CATALOG_TOP5) {
      expect(beyond.find((e) => e.id === curated.id)).toBeUndefined();
    }
  });
});

describe('estimateVideoCatalogCredits', () => {
  it('prices model x seconds with an exact per-resolution rate', () => {
    const grok15 = VIDEO_CATALOG_SNAPSHOT.find((e) => e.id === 'x-ai/grok-imagine-video-1.5')!;
    // 720p exact rate $0.14/s -> 280 credits/s -> 5s = 1400 credits, matching the
    // legacy table the send path uses (one credit means the same on both paths).
    expect(estimateVideoCatalogCredits({ entry: grok15, resolution: '720p', durationSeconds: 5 })).toEqual({
      credits: 1400,
      usdPerSecond: 0.14,
      approximateRate: false,
    });
  });

  it('falls back to the base price flagged approximate when no exact rate exists', () => {
    const hailuo = entry('minimax/hailuo-3', 0.13);
    // $0.13/s -> 260 credits/s -> 5s = 1300 credits.
    expect(estimateVideoCatalogCredits({ entry: hailuo, resolution: '720p', durationSeconds: 5 })).toEqual({
      credits: 1300,
      usdPerSecond: 0.13,
      approximateRate: true,
    });
  });

  it('refuses a resolution the model documents as unsupported', () => {
    const limited: VideoCatalogEntry = {
      id: 'vendor/sd-only',
      displayName: 'SD only',
      pricePerSecondUsd: 0.1,
      resolutions: ['480p'],
    };
    expect(estimateVideoCatalogCredits({ entry: limited, resolution: '1080p', durationSeconds: 5 })).toBeUndefined();
    expect(estimateVideoCatalogCredits({ entry: limited, resolution: '480p', durationSeconds: 5 })?.credits).toBe(1000);
  });
});

describe('formatVideoCatalogPrice', () => {
  it('renders the German decimal comma', () => {
    expect(formatVideoCatalogPrice(0.13)).toBe('0,13 $/s');
    expect(formatVideoCatalogPrice(0.5)).toBe('0,50 $/s');
  });
});
