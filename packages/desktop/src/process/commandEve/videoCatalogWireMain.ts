/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1773 (F8/F8b) — the LIVE video model catalog read, Main-side.
 *
 * The picker's catalog is server truth: `GET {eve-multimodal}/video-model-capabilities`
 * serves the pinned OpenRouter video catalog (protocol
 * `command-eve-video-model-catalog/v1`): id, display name, resolutions,
 * durations, aspect ratios and the per-resolution USD/credits-per-second
 * maps. Main holds the CEVE bearer and is the only side that talks to the
 * gateway — the renderer never sees the wire (same pattern as
 * `image-model-capabilities`).
 *
 * SELF-QUIET by contract: any failure (no bearer, offline, non-2xx, malformed
 * body, no usable catalog) resolves to `null`, and the caller falls back to
 * the bundled snapshot marked approximate. A failed read must never break the
 * composer, and a fabricated catalog must never stand in for the server's.
 */

import { EVE_MULTIMODAL_FUNCTION_URL } from '@/common/config/eveMultimodalGatewayCore';
import { readLicenseWire } from '@/common/config/licenseWireAtRest';
import { parseVideoCatalogWire, type VideoCatalogEntry } from '@/common/config/videoCatalogCore';

/** The catalog read endpoint on the multimodal gateway (mirrors image-model-capabilities). */
export const VIDEO_MODEL_CAPABILITIES_URL = `${EVE_MULTIMODAL_FUNCTION_URL}/video-model-capabilities`;

/** Bounded wait for the catalog read — the picker must not hang on a stall. */
const VIDEO_CATALOG_WIRE_TIMEOUT_MS = 8_000;

/**
 * Read the live video catalog, or `null` on any failure. Never throws.
 */
export async function readVideoCatalogWire(dataPath: string): Promise<VideoCatalogEntry[] | null> {
  try {
    const wireResult = readLicenseWire(dataPath);
    if (!wireResult.ok || !wireResult.wire) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VIDEO_CATALOG_WIRE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(VIDEO_MODEL_CAPABILITIES_URL, {
        method: 'GET',
        headers: {
          // The wire travels only in the Authorization HEADER — never logged,
          // never returned to the renderer (same pattern as credits-status).
          Authorization: `Bearer ${wireResult.wire}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return null;

    const body = (await response.json().catch((): null => null)) as unknown;
    return parseVideoCatalogWire(body);
  } catch {
    return null;
  }
}
