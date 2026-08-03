/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Main-process reader for the SERVER-OWNED image model registry (MAT-1769).
 *
 * Both consumers of the registry — the composer's three-way selector (via the
 * `command-eve.image-capabilities` bridge) and the managed image generation
 * lane (which resolves the seat's tier to a registry-pinned slug right before
 * the request) — read through this module so there is exactly ONE fetch, ONE
 * parse, and ONE failure doctrine:
 *
 *   - the surface is NON-BILLABLE: a GET on the capabilities path with the
 *     CEVE bearer. It can never create, reserve, or debit anything;
 *   - every failure — no license, network error, non-2xx, unparseable body —
 *     is `{ ok: false }`. There is NO cached-literal fallback anywhere: a
 *     client that cannot prove the current registry shows "price unavailable"
 *     and a generation that cannot prove it refuses, honestly;
 *   - successes are cached for a short TTL so the composer does not round-trip
 *     the gateway on every keystroke-adjacent render, and failures for a much
 *     shorter one so a flapping gateway does not get hammered by retries.
 */

import {
  COMMAND_EVE_IMAGE_MODEL_CAPABILITIES_PATH,
  parseCommandEveImageModelRegistry,
  type CommandEveImageModelRegistryResult,
} from '@/common/config/eveImageModelRegistryCore';
import { EVE_MULTIMODAL_FUNCTION_URL } from '@/common/config/eveMultimodalGatewayCore';
import { readLicenseWire } from '@/common/config/licenseWireAtRest';
import { readCommandEveLimitedResponseText } from './limitedFetchResponse';
import { getDataPath } from '@process/utils/utils';

const CAPABILITIES_TIMEOUT_MS = 15_000;
const CAPABILITIES_MAX_RESPONSE_BYTES = 64 * 1024;
const SUCCESS_CACHE_TTL_MS = 60_000;
const FAILURE_CACHE_TTL_MS = 10_000;

export type CommandEveImageCapabilitiesFetchOptions = {
  fetchFn?: typeof fetch;
  dataPath?: string;
  /** Bypass the in-memory cache (the generation lane does — a request must price NOW). */
  bypassCache?: boolean;
};

type CacheEntry = { result: CommandEveImageModelRegistryResult; expiresAtMs: number };

let cache: CacheEntry | undefined;

export function clearCommandEveImageModelRegistryCacheForTests(): void {
  cache = undefined;
}

async function fetchRegistryUncached(
  options: CommandEveImageCapabilitiesFetchOptions
): Promise<CommandEveImageModelRegistryResult> {
  const wireResult = readLicenseWire(options.dataPath ?? getDataPath());
  if (!wireResult.ok || !wireResult.wire) {
    return { ok: false, reason: 'missing_license' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPABILITIES_TIMEOUT_MS);
  try {
    const response = await (options.fetchFn ?? fetch)(
      `${EVE_MULTIMODAL_FUNCTION_URL}${COMMAND_EVE_IMAGE_MODEL_CAPABILITIES_PATH}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${wireResult.wire}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      }
    );
    if (!response.ok) {
      return { ok: false, reason: 'capabilities_http_error' };
    }
    const responseText = await readCommandEveLimitedResponseText(response, CAPABILITIES_MAX_RESPONSE_BYTES);
    if (!responseText.ok) {
      return { ok: false, reason: 'capabilities_unparseable' };
    }
    let raw: unknown = null;
    try {
      raw = JSON.parse(responseText.text);
    } catch {
      raw = null;
    }
    const registry = parseCommandEveImageModelRegistry(raw);
    if (!registry) {
      return { ok: false, reason: 'capabilities_unparseable' };
    }
    return { ok: true, registry };
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
    return { ok: false, reason: name === 'AbortError' ? 'capabilities_timeout' : 'capabilities_failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the registry, through the short-lived cache unless bypassed. A
 * generation request bypasses: the quote shown a minute ago may inform a
 * choice, but the price applied to a request must be provable NOW.
 */
export async function readCommandEveImageModelRegistry(
  options: CommandEveImageCapabilitiesFetchOptions = {}
): Promise<CommandEveImageModelRegistryResult> {
  const nowMs = Date.now();
  if (!options.bypassCache && cache && cache.expiresAtMs > nowMs) {
    return cache.result;
  }
  const result = await fetchRegistryUncached(options);
  cache = {
    result,
    expiresAtMs: nowMs + (result.ok ? SUCCESS_CACHE_TTL_MS : FAILURE_CACHE_TTL_MS),
  };
  return result;
}
