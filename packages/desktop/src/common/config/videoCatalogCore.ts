/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE VIDEO model catalog — pure catalog core (MAT-1773, F8/F8b).
 *
 * The video model picker is fed by the OpenRouter video catalog the server
 * serves at `GET {eve-multimodal}/video-model-capabilities` (protocol
 * `command-eve-video-model-catalog/v1`). This module owns:
 *
 *   - the WIRE contract ({@link parseVideoCatalogWire}) — the REAL response
 *     shape, parsed defensively: `models[]` with `display_name`, `resolutions`
 *     /`durations`/`aspect_ratios` (each nullable) and the per-resolution
 *     `usd_per_second` / `credits_per_second` maps (key `"default"` for
 *     resolution-flat models like runway/aleph-2);
 *   - the BUNDLED SNAPSHOT ({@link VIDEO_CATALOG_SNAPSHOT}) — a dated mirror
 *     of the server's own pinned 2026-08-05 catalog view (18 priceable
 *     models; the three token-priced Seedance models are unpriceable upstream
 *     and therefore unofferable here too). Used only when the capabilities
 *     read fails, and always marked approximate;
 *   - the CURATED TOP-5 ({@link resolveVideoCatalogTopFive}) — a fixed,
 *     ordered shortlist (Grok Imagine Video 1.5 first — it stays the
 *     default). A curated model the served catalog does not carry is SKIPPED
 *     (today: Seedance 2.0, token-priced upstream) rather than listed with an
 *     invented price;
 *   - the SELECTION resolver ({@link resolveVideoCatalogSelection}) — filters
 *     resolution/duration to what the SELECTED model supports and auto-picks
 *     the NEAREST supported value when the current one is not, so an invalid
 *     combination is unreachable in the UI instead of erroring late;
 *   - the PRICE MATH ({@link estimateVideoCatalogCredits}) — the exact
 *     model x resolution x duration combination, preferring the SERVER's own
 *     `credits_per_second` (ceil-rounded like the reserve bound) and falling
 *     back to the same ceil derivation, so the dropdown can never quote less
 *     than the server would charge.
 *
 * PURE (no Electron, no fs, no network), mirroring `videoCostCore.ts`.
 */

import { baseVideoCatalogPrice } from './videoCostCore';

/**
 * One catalog entry, mirroring the server's
 * `command-eve-video-model-catalog/v1` model view.
 */
export interface VideoCatalogEntry {
  /** Provider-qualified id, e.g. `x-ai/grok-imagine-video-1.5`. */
  id: string;
  /** Display name as served (often vendor-prefixed, `Google: Veo 3.1`). */
  displayName: string;
  /** Supported resolutions; `null` = resolution-flat (e.g. runway/aleph-2). */
  resolutions: readonly string[] | null;
  /** Supported clip durations in seconds; `null` = no published list. */
  durations: readonly number[] | null;
  /** Supported aspect ratios, when published. */
  aspectRatios?: readonly string[] | null;
  /** USD list price per generated second, keyed by resolution (`"default"` when flat). */
  usdPerSecond: Readonly<Record<string, number>>;
  /**
   * The SERVER's own retail credits per second per resolution (ceil-rounded
   * like the reserve bound). Preferred over any client-side derivation — the
   * dropdown then quotes exactly what the server would charge.
   */
  creditsPerSecond?: Readonly<Record<string, number>>;
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

const asFinitePositiveNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

const asStringList = (value: unknown): readonly string[] | null | undefined => {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return list.length > 0 ? list : null;
};

const asDurationList = (value: unknown): readonly number[] | null | undefined => {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item) && item > 0);
  return list.length > 0 ? list : null;
};

const asPriceMap = (value: unknown): Readonly<Record<string, number>> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const map: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const price = asFinitePositiveNumber(raw);
    if (price !== undefined) map[key] = price;
  }
  return Object.keys(map).length > 0 ? map : undefined;
};

const parseEntry = (value: unknown): VideoCatalogEntry | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const displayNameRaw = record.display_name ?? record.displayName ?? record.name;
  const displayName = typeof displayNameRaw === 'string' ? displayNameRaw.trim() : '';
  const usdPerSecond = asPriceMap(record.usd_per_second ?? record.usdPerSecond);
  if (!id || !displayName || usdPerSecond === undefined) return null;

  const entry: VideoCatalogEntry = { id, displayName, resolutions: null, durations: null, usdPerSecond };
  const resolutions = asStringList(record.resolutions);
  if (resolutions !== undefined) entry.resolutions = resolutions;
  const durations = asDurationList(record.durations);
  if (durations !== undefined) entry.durations = durations;
  const aspectRatios = asStringList(record.aspect_ratios ?? record.aspectRatios);
  if (aspectRatios !== undefined && aspectRatios !== null) entry.aspectRatios = aspectRatios;
  const creditsPerSecond = asPriceMap(record.credits_per_second ?? record.creditsPerSecond);
  if (creditsPerSecond !== undefined) entry.creditsPerSecond = creditsPerSecond;
  return entry;
};

/**
 * Parse the `video-model-capabilities` response. Accepts the served envelope
 * (`{ version, models: [...] }`) or a bare model array. Returns `null` when
 * nothing usable is present — the caller then falls back to the bundled
 * snapshot. Individually-bad rows are dropped, not fatal; `enabled: false`
 * still yields the catalog (the price list is not a secret — the server
 * serves it disabled too).
 */
export function parseVideoCatalogWire(payload: unknown): VideoCatalogEntry[] | null {
  let list: unknown = payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    list = record.models ?? record.video_catalog ?? record.videoCatalog;
  }
  if (!Array.isArray(list)) return null;
  const entries = list.map(parseEntry).filter((entry): entry is VideoCatalogEntry => entry !== null);
  return entries.length > 0 ? entries : null;
}

// ---------------------------------------------------------------------------
// The bundled fallback snapshot — a dated mirror of the server's own view
// ---------------------------------------------------------------------------

/**
 * Static mirror of the server's pinned 2026-08-05 catalog view
 * (`catalog_snapshot: "2026-08-05"`, 18 priceable models — the three
 * token-priced Seedance models are unpriceable upstream and deliberately
 * absent: an invented per-second price is not a fallback, it is a lie).
 * Prices and bounds are the server's OWN resolved figures, so the fallback
 * quotes what the server would charge; it is still presented as approximate
 * because it can go stale between releases.
 */
export const VIDEO_CATALOG_SNAPSHOT: readonly VideoCatalogEntry[] = [
  {
    id: 'black-forest-labs/flux-3-video',
    displayName: 'Black Forest Labs: FLUX.3 Video',
    resolutions: ['720p', '1080p'],
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    usdPerSecond: { '720p': 0.17, '1080p': 0.29 },
    creditsPerSecond: { '720p': 340, '1080p': 580 },
  },
  {
    id: 'minimax/hailuo-3',
    displayName: 'MiniMax: H3',
    resolutions: ['2K'],
    durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    usdPerSecond: { '2K': 0.13 },
    creditsPerSecond: { '2K': 260 },
  },
  {
    id: 'runway/aleph-2',
    displayName: 'Runway: Aleph 2.0',
    resolutions: null,
    durations: null,
    usdPerSecond: { default: 0.28 },
    creditsPerSecond: { default: 560 },
  },
  {
    id: 'runway/gen-4.5',
    displayName: 'Runway: Gen-4.5',
    resolutions: ['720p'],
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    usdPerSecond: { '720p': 0.12 },
    creditsPerSecond: { '720p': 240 },
  },
  {
    id: 'x-ai/grok-imagine-video-1.5',
    displayName: 'SpaceXAI: Grok Imagine Video 1.5',
    resolutions: ['480p', '720p', '1080p'],
    durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    usdPerSecond: { '480p': 0.08, '720p': 0.14, '1080p': 0.25 },
    creditsPerSecond: { '480p': 160, '720p': 280, '1080p': 500 },
  },
  {
    id: 'alibaba/happyhorse-1.1',
    displayName: 'Alibaba: HappyHorse 1.1',
    resolutions: ['720p', '1080p'],
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    usdPerSecond: { '720p': 0.0988, '1080p': 0.1278 },
    creditsPerSecond: { '720p': 200, '1080p': 260 },
  },
  {
    id: 'alibaba/happyhorse-1.0',
    displayName: 'Alibaba: HappyHorse 1.0',
    resolutions: ['720p', '1080p'],
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    usdPerSecond: { '720p': 0.0988, '1080p': 0.1694 },
    creditsPerSecond: { '720p': 200, '1080p': 340 },
  },
  {
    id: 'x-ai/grok-imagine-video',
    displayName: 'SpaceXAI: Grok Imagine Video',
    resolutions: ['480p', '720p'],
    durations: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    usdPerSecond: { '480p': 0.05, '720p': 0.07 },
    creditsPerSecond: { '480p': 100, '720p': 140 },
  },
  {
    id: 'kwaivgi/kling-v3.0-pro',
    displayName: 'Kling: Video v3.0 Pro',
    resolutions: ['720p'],
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    usdPerSecond: { '720p': 0.112 },
    creditsPerSecond: { '720p': 240 },
  },
  {
    id: 'kwaivgi/kling-v3.0-std',
    displayName: 'Kling: Video v3.0 Standard',
    resolutions: ['720p'],
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    usdPerSecond: { '720p': 0.084 },
    creditsPerSecond: { '720p': 180 },
  },
  {
    id: 'google/veo-3.1-fast',
    displayName: 'Google: Veo 3.1 Fast',
    resolutions: ['720p', '1080p', '4K'],
    durations: [4, 6, 8],
    usdPerSecond: { '720p': 0.1, '1080p': 0.12, '4K': 0.3 },
    creditsPerSecond: { '720p': 200, '1080p': 240, '4K': 600 },
  },
  {
    id: 'google/veo-3.1-lite',
    displayName: 'Google: Veo 3.1 Lite',
    resolutions: ['720p', '1080p'],
    durations: [8, 4, 6],
    usdPerSecond: { '720p': 0.05, '1080p': 0.08 },
    creditsPerSecond: { '720p': 100, '1080p': 160 },
  },
  {
    id: 'kwaivgi/kling-video-o1',
    displayName: 'Kling: Video O1',
    resolutions: ['720p'],
    durations: [5, 10],
    usdPerSecond: { '720p': 0.112 },
    creditsPerSecond: { '720p': 240 },
  },
  {
    id: 'minimax/hailuo-2.3',
    displayName: 'MiniMax: Hailuo 2.3',
    resolutions: ['1080p'],
    durations: [6, 10],
    usdPerSecond: { '1080p': 0.0817 },
    creditsPerSecond: { '1080p': 180 },
  },
  {
    id: 'alibaba/wan-2.7',
    displayName: 'Alibaba: Wan 2.7',
    resolutions: ['720p', '1080p'],
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    usdPerSecond: { '720p': 0.1, '1080p': 0.1 },
    creditsPerSecond: { '720p': 200, '1080p': 200 },
  },
  {
    id: 'alibaba/wan-2.6',
    displayName: 'Alibaba: Wan 2.6',
    resolutions: ['720p', '1080p'],
    durations: [5, 10],
    usdPerSecond: { '720p': 0.08, '1080p': 0.12 },
    creditsPerSecond: { '720p': 160, '1080p': 240 },
  },
  {
    id: 'openai/sora-2-pro',
    displayName: 'OpenAI: Sora 2 Pro',
    resolutions: ['720p', '1080p'],
    durations: [4, 8, 12, 16, 20],
    usdPerSecond: { '720p': 0.3, '1080p': 0.5 },
    creditsPerSecond: { '720p': 600, '1080p': 1000 },
  },
  {
    id: 'google/veo-3.1',
    displayName: 'Google: Veo 3.1',
    resolutions: ['720p', '1080p', '4K'],
    durations: [4, 6, 8],
    usdPerSecond: { '720p': 0.4, '1080p': 0.4, '4K': 0.6 },
    creditsPerSecond: { '720p': 800, '1080p': 800, '4K': 1200 },
  },
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
 * Each entry carries the id the catalog is expected to use plus the display
 * name the row should show. A curated model the served catalog does not carry
 * is SKIPPED, not listed with an invented price — today that is Seedance 2.0,
 * which is token-priced upstream and lands in the server's `unpriceable`
 * list, so the shortlist shows four until upstream prices it per second.
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
 * Everything behind 'Weitere anzeigen': the catalog minus the curated
 * shortlist, sorted by USD/second ascending (cheapest first — the base rate,
 * i.e. the cheapest resolution key). Ties keep the catalog order.
 *
 * DEDUPE IS BY NORMALIZED ID, not object identity (founder-visible bug,
 * 1.820.5): a curated model must NEVER appear twice — once in 'Empfohlen' and
 * again in 'Alle Modelle' — even when the server qualifies the id differently
 * than the curated spec and the top-five matched it by display name.
 */
export function listVideoCatalogBeyondTopFive(entries: readonly VideoCatalogEntry[]): VideoCatalogEntry[] {
  const topKeys = new Set(resolveVideoCatalogTopFive(entries).map((entry) => normalizeCatalogKey(entry.id)));
  return entries
    .filter((entry) => !topKeys.has(normalizeCatalogKey(entry.id)))
    .toSorted((a, b) => baseVideoCatalogPrice(a) - baseVideoCatalogPrice(b));
}

/**
 * The name a row shows: the curated display name for TOP-5 entries (the
 * founder's spelling, e.g. `FLUX.3 Video`), otherwise the served name with
 * the vendor prefix de-colonised (`MiniMax: H3` -> `MiniMax H3`).
 */
export function displayVideoCatalogName(entry: VideoCatalogEntry): string {
  const curated = VIDEO_CATALOG_TOP5.find((candidate) => entryMatchesCurated(entry, candidate));
  if (curated) return curated.displayName;
  return entry.displayName.replace(/:\s+/, ' ');
}

/**
 * The provider identity for a row's chip (1.820.5 P2): a stable key derived
 * from the vendor part of the id (`x-ai/grok-…` -> `xai`) plus a short label.
 */
export function videoCatalogProvider(entry: VideoCatalogEntry): { key: string; label: string } {
  const vendor = entry.id.includes('/') ? entry.id.slice(0, entry.id.indexOf('/')) : entry.id;
  const key = vendor.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const labels: Record<string, string> = {
    xai: 'xAI',
    google: 'Google',
    openai: 'OpenAI',
    blackforestlabs: 'FLUX',
    bytedance: 'ByteDance',
    minimax: 'MiniMax',
    kwaivgi: 'Kling',
    alibaba: 'Alibaba',
    runway: 'Runway',
    happyhorse: 'HappyHorse',
  };
  const label = labels[key] ?? vendor.charAt(0).toUpperCase() + vendor.slice(1);
  return { key, label };
}

// ---------------------------------------------------------------------------
// Selection resolver — invalid combinations become UNSELECTABLE
// ---------------------------------------------------------------------------

/** Numeric rank for "nearest resolution" — 480p < 720p < 1080p < 2K < 4K. */
const resolutionRank = (resolution: string): number => {
  const match = /^(\d+(?:\.\d+)?)\s*([kK]?)[pP]?$/.exec(resolution.trim());
  if (!match) return Number.MAX_SAFE_INTEGER / 2;
  const value = Number(match[1]);
  return match[2] ? value * 1000 : value;
};

const nearestByRank = <T>(candidates: readonly T[], rank: (candidate: T) => number, target: number): T => {
  let best = candidates[0];
  for (const candidate of candidates) {
    const distance = Math.abs(rank(candidate) - target);
    const bestDistance = Math.abs(rank(best) - target);
    // Strictly closer wins; an exact tie keeps the LOWER candidate (the
    // cheaper direction is the honest default for an automatic pick).
    if (distance < bestDistance || (distance === bestDistance && rank(candidate) < rank(best))) {
      best = candidate;
    }
  }
  return best;
};

export interface VideoCatalogSelection {
  /** The effective resolution — `null` for a resolution-flat model. */
  resolution: string | null;
  /** The effective duration in seconds — `null` when the model publishes no list. */
  durationSeconds: number | null;
  /** True when the requested resolution was unsupported and auto-picked. */
  resolutionAdjusted: boolean;
  /** True when the requested duration was unsupported and auto-picked. */
  durationAdjusted: boolean;
}

/**
 * Filter a (resolution, duration) request to what the SELECTED model actually
 * supports. An unsupported value is replaced by the NEAREST supported one
 * (tie-break: the lower/cheaper value) and the adjustment is flagged, so the
 * UI can show the change instead of failing late. A model with a null list is
 * unconstrained on that axis.
 */
export function resolveVideoCatalogSelection(input: {
  entry: VideoCatalogEntry;
  resolution?: string | null;
  durationSeconds?: number | null;
}): VideoCatalogSelection {
  const { entry } = input;

  let resolution: string | null;
  let resolutionAdjusted = false;
  if (entry.resolutions === null) {
    resolution = null;
  } else if (input.resolution != null && entry.resolutions.includes(input.resolution)) {
    resolution = input.resolution;
  } else if (input.resolution != null) {
    resolution = nearestByRank(entry.resolutions, resolutionRank, resolutionRank(input.resolution));
    resolutionAdjusted = resolution !== input.resolution;
  } else {
    // No request: the ECONOMICAL default is the cheapest supported resolution.
    resolution = nearestByRank(entry.resolutions, resolutionRank, 0);
  }

  let durationSeconds: number | null;
  let durationAdjusted = false;
  if (entry.durations === null) {
    durationSeconds = input.durationSeconds ?? null;
  } else if (input.durationSeconds != null && entry.durations.includes(input.durationSeconds)) {
    durationSeconds = input.durationSeconds;
  } else if (input.durationSeconds != null) {
    durationSeconds = nearestByRank(entry.durations, (candidate) => candidate, input.durationSeconds);
    durationAdjusted = durationSeconds !== input.durationSeconds;
  } else {
    durationSeconds = nearestByRank(entry.durations, (candidate) => candidate, 0);
  }

  return { resolution, durationSeconds, resolutionAdjusted, durationAdjusted };
}
/**
 * The price helpers' canonical implementations live in `videoCostCore` (the
 * runtime import graph stays one-directional); re-exported here so catalog
 * consumers import one module.
 */
export {
  baseVideoCatalogPrice,
  deriveVideoCatalogCreditsPerSecond,
  videoCatalogCreditsPerSecond,
  videoCatalogUsdPerSecond,
} from './videoCostCore';

import {
  videoCatalogCreditsPerSecond as creditsPerSecondFor,
  videoCatalogUsdPerSecond as usdPerSecondFor,
} from './videoCostCore';

export interface VideoCatalogEstimate {
  /** Estimated credits for the clip (rounded UP — never understate). */
  credits: number;
  /** The USD/s rate the estimate used. */
  usdPerSecond: number;
  /** The credits/s rate the estimate used (server figure when carried). */
  creditsPerSecond: number;
}

/**
 * Estimate credits for the EXACT (model, resolution, duration) combination.
 * Resolution `null` is the resolution-flat case (runway/aleph-2). Returns
 * `undefined` only when the entry has no price at all — entries are
 * price-checked at parse time, so this is a guard, not an expectation.
 */
export function estimateVideoCatalogCredits(input: {
  entry: VideoCatalogEntry;
  resolution: string | null;
  durationSeconds: number;
}): VideoCatalogEstimate | undefined {
  const usdPerSecond = usdPerSecondFor(input.entry, input.resolution);
  if (usdPerSecond === undefined) return undefined;
  const creditsPerSecond = creditsPerSecondFor(input.entry, input.resolution);
  const seconds =
    typeof input.durationSeconds === 'number' && Number.isFinite(input.durationSeconds) && input.durationSeconds > 0
      ? Math.ceil(input.durationSeconds)
      : 1;
  return {
    credits: Math.ceil(seconds * creditsPerSecond),
    usdPerSecond,
    creditsPerSecond,
  };
}

/** Format a USD/s list price, German decimal comma, sub-cent precision kept. */
export function formatVideoCatalogPrice(usdPerSecond: number): string {
  const rendered = usdPerSecond.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `${rendered.replace('.', ',')} $/s`;
}
