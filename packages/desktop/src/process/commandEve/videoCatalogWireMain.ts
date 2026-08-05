/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1773 (F8) — the LIVE video model catalog read, Main-side.
 *
 * The picker's catalog is server truth: the capabilities endpoint carries the
 * OpenRouter video catalog (id, display name, USD/s list price, documented
 * duration/resolution bounds). Main holds the CEVE bearer and is the only side
 * that talks to the billing endpoints — the renderer never sees the wire.
 *
 * SELF-QUIET by contract: any failure (no bearer, offline, non-2xx, malformed
 * body, no usable catalog) resolves to `null`, and the caller falls back to
 * the bundled snapshot marked approximate. A failed read must never break the
 * composer, and a fabricated catalog must never stand in for the server's.
 *
 * SEAM NOTE: the catalog rides on the billing capabilities/status payload
 * (`video_catalog`) until the parallel server session's dedicated endpoint
 * lands; the parse is shared (`parseVideoCatalogWire`) so only this reader
 * changes when the endpoint shape settles.
 */

import { CREDITS_STATUS_FUNCTION_URL } from '@/common/config/creditsCore';
import { readLicenseWire } from '@/common/config/licenseWireAtRest';
import { parseVideoCatalogWire, type VideoCatalogEntry } from '@/common/config/videoCatalogCore';

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
      response = await fetch(CREDITS_STATUS_FUNCTION_URL, {
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
