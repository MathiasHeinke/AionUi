/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE VIDEO model catalog — pure catalog core (MAT-1773, F8).
 *
 * The video model picker is fed by the OpenRouter video catalog, which the
 * server exposes through the capabilities endpoint. This module owns:
 *
 *   - the WIRE contract ({@link parseVideoCatalogWire}) — defensive, because the
 *     endpoint answer is server truth and a malformed body must degrade, never
 *     crash the composer;
 *   - the BUNDLED SNAPSHOT ({@link VIDEO_CATALOG_SNAPSHOT}) — the offline
 *     fallback the picker falls back to when the capabilities call fails. Its
 *     prices are marked approximate wherever they surface: a fallback must
 *     never read as live truth;
 *   - the CURATED TOP-5 ({@link resolveVideoCatalogTopFive}) — a fixed, ordered
 *     shortlist (Grok Imagine Video 1.5 first — it stays the default), matched
 *     against catalog entries by id with a display-name fallback, so vendor
 *     prefix drift on the server cannot silently empty the shortlist;
 *   - the PRICE MATH ({@link estimateVideoCatalogCredits}) — model price/s x
 *     seconds x resolution, through the same credits derivation
 *     ({@link deriveVideoCreditsPerSecond}) the legacy xAI table uses, so one
 *     credit means the same thing on both paths.
 *
 * PURE (no Electron, no fs, no network), mirroring `videoCostCore.ts`.
 */

import { deriveVideoCreditsPerSecond, type VideoResolution } from './videoCostCore';

/**
 * Map a catalog id back to a legacy xAI model id when it names one of the two
 * established models. Re-exported from its canonical home in `videoCostCore`
 * so catalog consumers import one module, not two.
 */
export { legacyVideoModelIdForCatalogId } from './videoCostCore';

/** One catalog entry: a video model the seat can pick, with its list price. */
export interface VideoCatalogEntry {
  /** Provider-qualified id, e.g. `x-ai/grok-imagine-video-1.5`. */
  id: string;
  /** Human display name, e.g. `Grok Imagine Video 1.5`. */
  displayName: string;
  /** Base list price per generated second, USD. */
  pricePerSecondUsd: number;
  /** Per-resolution overrides when the provider documents them. */
  pricesByResolution?: Readonly<Partial<Record<VideoResolution, number>>>;
  /** Resolutions the model can produce, when documented. */
  resolutions?: readonly VideoResolution[];
  /** Duration bounds in seconds, when documented. */
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
}

/** Where the entries the picker shows came from. */
export type VideoCatalogSource = 'live' | 'fallback';

export interface VideoCatalogResolution {
  entries: readonly VideoCatalogEntry[];
  source: VideoCatalogSource;
  /** True iff prices must be presented as approximate (the fallback snapshot). */
  approximate: boolean;
}

// ---------------------------------------------------------------------------
// Wire parsing (defensive — the endpoint answer is not trusted)
// ---------------------------------------------------------------------------

const VIDEO_RESOLUTIONS: readonly VideoResolution[] = ['480p', '720p', '1080p'];

const asFinitePositiveNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

const asResolution = (value: unknown): VideoResolution | undefined =>
  typeof value === 'string' && (VIDEO_RESOLUTIONS as readonly string[]).includes(value)
    ? (value as VideoResolution)
    : undefined;

const parseEntry = (value: unknown): VideoCatalogEntry | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const displayNameRaw = record.display_name ?? record.displayName ?? record.name;
  const displayName = typeof displayNameRaw === 'string' ? displayNameRaw.trim() : '';
  const price = asFinitePositiveNumber(record.price_per_second_usd) ?? asFinitePositiveNumber(record.pricePerSecondUsd);
  if (!id || !displayName || price === undefined) return null;

  const entry: VideoCatalogEntry = { id, displayName, pricePerSecondUsd: price };

  const pricesRaw = record.prices_by_resolution ?? record.pricesByResolution;
  if (pricesRaw && typeof pricesRaw === 'object') {
    const prices: Partial<Record<VideoResolution, number>> = {};
    for (const resolution of VIDEO_RESOLUTIONS) {
      const resolutionPrice = asFinitePositiveNumber((pricesRaw as Record<string, unknown>)[resolution]);
      if (resolutionPrice !== undefined) prices[resolution] = resolutionPrice;
    }
    if (Object.keys(prices).length > 0) entry.pricesByResolution = prices;
  }

  if (Array.isArray(record.resolutions)) {
    const resolutions = record.resolutions
      .map(asResolution)
      .filter((resolution): resolution is VideoResolution => resolution !== undefined);
    if (resolutions.length > 0) entry.resolutions = resolutions;
  }

  const minDuration = asFinitePositiveNumber(record.min_duration_seconds ?? record.minDurationSeconds);
  const maxDuration = asFinitePositiveNumber(record.max_duration_seconds ?? record.maxDurationSeconds);
  if (minDuration !== undefined) entry.minDurationSeconds = minDuration;
  if (maxDuration !== undefined) entry.maxDurationSeconds = maxDuration;

  return entry;
};

/**
 * Parse the capabilities endpoint's `video_catalog` payload. Accepts either the
 * bare array or a wrapper (`{ video_catalog: [...] }` / `{ models: [...] }`).
 * Returns `null` when nothing usable is present — the caller then falls back
 * to the bundled snapshot. Entries that fail individually are dropped, not
 * fatal: one bad row must not hide twenty good ones.
 */
export function parseVideoCatalogWire(payload: unknown): VideoCatalogEntry[] | null {
  let list: unknown = payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    list = record.video_catalog ?? record.videoCatalog ?? record.models;
  }
  if (!Array.isArray(list)) return null;
  const entries = list.map(parseEntry).filter((entry): entry is VideoCatalogEntry => entry !== null);
  return entries.length > 0 ? entries : null;
}

// ---------------------------------------------------------------------------
// The bundled fallback snapshot (21 models, prices APPROXIMATE)
// ---------------------------------------------------------------------------

/**
 * Static snapshot of the OpenRouter video catalog (21 models), shipped with the
 * app so the picker still works when the capabilities call fails. Prices are
 * list-price estimates and MUST be presented as approximate (`ca.`) wherever
 * they surface — the live catalog replaces them the moment the endpoint
 * answers. Ordering anchor per founder decision 2026-08-05: the cheapest entry
 * is MiniMax Hailuo 3 at ~$0.13/s.
 */
export const VIDEO_CATALOG_SNAPSHOT: readonly VideoCatalogEntry[] = [
  { id: 'minimax/hailuo-3', displayName: 'MiniMax Hailuo 3', pricePerSecondUsd: 0.13 },
  { id: 'minimax/hailuo-2.3', displayName: 'MiniMax Hailuo 2.3', pricePerSecondUsd: 0.14 },
  { id: 'happyhorse/happyhorse-1.0', displayName: 'HappyHorse 1.0', pricePerSecondUsd: 0.15 },
  { id: 'happyhorse/happyhorse-1.1', displayName: 'HappyHorse 1.1', pricePerSecondUsd: 0.16 },
  { id: 'alibaba/wan-2.6', displayName: 'Wan 2.6', pricePerSecondUsd: 0.18 },
  { id: 'alibaba/wan-2.7', displayName: 'Wan 2.7', pricePerSecondUsd: 0.2 },
  { id: 'kling/kling-video-o1', displayName: 'Kling Video O1', pricePerSecondUsd: 0.22 },
  { id: 'google/veo-3.1-lite', displayName: 'Google Veo 3.1 Lite', pricePerSecondUsd: 0.24 },
  { id: 'kling/kling-v3.0-std', displayName: 'Kling v3.0 Std', pricePerSecondUsd: 0.25 },
  { id: 'bytedance/seedance-1-5-pro', displayName: 'Seedance 1.5 Pro', pricePerSecondUsd: 0.28 },
  { id: 'x-ai/grok-imagine-video', displayName: 'Grok Imagine Video', pricePerSecondUsd: 0.3 },
  {
    id: 'x-ai/grok-imagine-video-1.5',
    displayName: 'Grok Imagine Video 1.5',
    pricePerSecondUsd: 0.32,
    pricesByResolution: { '480p': 0.08, '720p': 0.14, '1080p': 0.25 },
    resolutions: ['480p', '720p', '1080p'],
    maxDurationSeconds: 15,
  },
  { id: 'bytedance/seedance-2.0-fast', displayName: 'Seedance 2.0 Fast', pricePerSecondUsd: 0.33 },
  { id: 'runway/gen-4.5', displayName: 'Runway Gen-4.5', pricePerSecondUsd: 0.35 },
  { id: 'bytedance/seedance-2.0', displayName: 'Seedance 2.0', pricePerSecondUsd: 0.38 },
  { id: 'google/veo-3.1-fast', displayName: 'Google Veo 3.1 Fast', pricePerSecondUsd: 0.4 },
  { id: 'runway/aleph-2', displayName: 'Runway Aleph 2', pricePerSecondUsd: 0.42 },
  { id: 'kling/kling-v3.0-pro', displayName: 'Kling v3.0 Pro', pricePerSecondUsd: 0.45 },
  { id: 'black-forest-labs/flux-3-video', displayName: 'FLUX.3 Video', pricePerSecondUsd: 0.48 },
  { id: 'google/veo-3.1', displayName: 'Google Veo 3.1', pricePerSecondUsd: 0.5 },
  { id: 'openai/sora-2-pro', displayName: 'OpenAI Sora 2 Pro', pricePerSecondUsd: 0.6 },
] as const;

/**
 * Resolve the catalog the picker shows: the LIVE entries when the capabilities
 * call delivered a usable catalog, otherwise the bundled snapshot — flagged
 * approximate, because fallback prices must never read as live truth.
 */
export function resolveVideoCatalog(live: readonly VideoCatalogEntry[] | null | undefined): VideoCatalogResolution {
  if (Array.isArray(live) && live.length > 0) {
    return { entries: live, source: 'live', approximate: false };
  }
  return { entries: VIDEO_CATALOG_SNAPSHOT, source: 'fallback', approximate: true };
}

// ---------------------------------------------------------------------------
// The curated TOP-5 (fixed order, Grok Imagine Video 1.5 stays the default)
// ---------------------------------------------------------------------------

/**
 * The curated shortlist, in EXACTLY this order (founder decision 2026-08-05).
 * Each entry carries the id the catalog is expected to use plus a display-name
 * fallback: a server that qualifies ids differently (or renames the display
 * string) must not silently empty the shortlist.
 */
export const VIDEO_CATALOG_TOP5: readonly { id: string; displayName: string }[] = [
  { id: 'x-ai/grok-imagine-video-1.5', displayName: 'Grok Imagine Video 1.5' },
  { id: 'google/veo-3.1', displayName: 'Google Veo 3.1' },
  { id: 'openai/sora-2-pro', displayName: 'OpenAI Sora 2 Pro' },
  { id: 'black-forest-labs/flux-3-video', displayName: 'FLUX.3 Video' },
  { id: 'bytedance/seedance-2.0', displayName: 'Seedance 2.0' },
] as const;

/** The default selection — Grok Imagine Video 1.5 stays the default. */
export const DEFAULT_VIDEO_CATALOG_MODEL_ID = VIDEO_CATALOG_TOP5[0].id;

const normalizeCatalogKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/^[^/]+\//, '') // strip a vendor prefix: x-ai/grok-… -> grok-…
    .replace(/[^a-z0-9]+/g, '');

const entryMatchesCurated = (entry: VideoCatalogEntry, curated: { id: string; displayName: string }): boolean => {
  if (entry.id === curated.id) return true;
  return (
    normalizeCatalogKey(entry.id) === normalizeCatalogKey(curated.id) ||
    normalizeCatalogKey(entry.displayName) === normalizeCatalogKey(curated.displayName)
  );
};

/**
 * Map the curated TOP-5 onto real catalog entries, in the fixed curated order.
 * A curated model the catalog does not carry is skipped (the picker shows what
 * the catalog actually offers), so the result can be shorter than five — but
 * never reordered.
 */
export function resolveVideoCatalogTopFive(entries: readonly VideoCatalogEntry[]): VideoCatalogEntry[] {
  const top: VideoCatalogEntry[] = [];
  for (const curated of VIDEO_CATALOG_TOP5) {
    const match = entries.find((entry) => entryMatchesCurated(entry, curated));
    if (match && !top.includes(match)) top.push(match);
  }
  return top;
}

/**
 * Everything behind 'Weitere anzeigen': the catalog minus the TOP-5, sorted by
 * USD/second ascending (cheapest first). Ties keep the catalog order.
 */
export function listVideoCatalogBeyondTopFive(entries: readonly VideoCatalogEntry[]): VideoCatalogEntry[] {
  const top = resolveVideoCatalogTopFive(entries);
  return entries
    .filter((entry) => !top.includes(entry))
    .slice()
    .toSorted((a, b) => a.pricePerSecondUsd - b.pricePerSecondUsd);
}

// ---------------------------------------------------------------------------
// Price math — model x seconds x resolution, through the shared derivation
// ---------------------------------------------------------------------------

export interface VideoCatalogEstimate {
  /** Estimated credits for the clip (rounded UP — never understate). */
  credits: number;
  /** The USD/s rate the estimate used (after resolution lookup). */
  usdPerSecond: number;
  /**
   * True when no exact rate exists for the requested resolution and the base
   * price stood in — the number is then indicative, not the provider's quote
   * for that resolution.
   */
  approximateRate: boolean;
}

/**
 * Estimate credits for one catalog entry at a resolution and duration.
 *
 * Rate lookup order: an exact per-resolution price, else the entry's base
 * price (flagged approximate — quoting the 720p number for a 1080p render as
 * fact is the dishonesty this lane keeps having to unship). Returns
 * `undefined` when the entry documents resolutions and the requested one is
 * not among them: a price for a render the model cannot produce is a promise
 * the picker must not make.
 */
export function estimateVideoCatalogCredits(input: {
  entry: VideoCatalogEntry;
  resolution: VideoResolution;
  durationSeconds: number;
}): VideoCatalogEstimate | undefined {
  const { entry, resolution } = input;
  if (entry.resolutions && !entry.resolutions.includes(resolution)) return undefined;

  const exact = entry.pricesByResolution?.[resolution];
  const usdPerSecond = exact ?? entry.pricePerSecondUsd;
  const seconds =
    typeof input.durationSeconds === 'number' && Number.isFinite(input.durationSeconds) && input.durationSeconds > 0
      ? Math.ceil(input.durationSeconds)
      : 1;
  return {
    credits: Math.ceil(seconds * deriveVideoCreditsPerSecond(usdPerSecond)),
    usdPerSecond,
    approximateRate: exact === undefined,
  };
}

/**
 * Map a catalog id back to a legacy xAI {@link VideoModelId}-shaped slug when
 * it names one of the two established models (`x-ai/grok-imagine-video-1.5` →
 * `grok-imagine-video-1.5`). The legacy models keep their proven price table
 * and capability gates; only genuinely NEW models price from the catalog.
 *
 * (Canonical implementation lives in `videoCostCore` and is re-exported above.)
 */

/** Format a USD/s list price for the picker, German locale (`0,13 $/s`). */
export function formatVideoCatalogPrice(usdPerSecond: number): string {
  return `${usdPerSecond.toFixed(2).replace('.', ',')} $/s`;
}
