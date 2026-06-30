/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FULL-CHAIN regression test for the 1.2.19 "EVE Max routes as Flash" bug.
 *
 * The 1.2.19 fix added `resolveWireTierFromSelection` + 67 unit tests, but they
 * only proved the mapping in ISOLATION (string → tier). The LIVE chain still
 * produced `standard` because the main-process routing resolver read
 * `commandEve.inferenceSelection` from the WRONG store: it called
 * `ProcessConfig.getSync(...)` (the Electron-local JSON file) while the picker
 * persists the value to the aioncore BACKEND settings store (`/api/settings/client`
 * → SQLite `client_preferences`). So the read ALWAYS returned undefined and the
 * picked level (High/Max) silently defaulted to Standard → DeepSeek V4 Flash.
 *
 * This test exercises the WHOLE chain the shim runs per request:
 *   picker commit value (backend store)
 *     → readInferenceSelectionFromBackend  [seat-physical key, /api/settings/client]
 *     → resolveEffectiveInferenceSelection
 *     → isEveInferenceSelection → resolveWireTierFromSelection
 *     → buildEveCloudRoute → route.tier
 *
 * It is RED against the pre-fix code: with the resolver reading ProcessConfig
 * (which never holds the key), the route tier is `standard` even when the
 * backend store says the user picked EVE Max.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the backend HTTP read so we can simulate the picker's persisted value
// exactly as the renderer's configService.set writes it (seat-physical key in
// the /api/settings/client bag).
const httpRequestMock = vi.fn();
vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: (...args: unknown[]) => httpRequestMock(...args),
}));

import {
  readInferenceSelectionFromBackend,
  resolveEveCloudRouteFromBackend,
} from '@process/commandEve/inferenceSelectionBackendRead';
import { eveTierValue, localTierValue } from '@/common/config/eveInferenceCore';
import {
  __resetActiveSeatForTests,
  setActiveSeatId,
} from '@process/commandEve/seatContextCore';
import { seatScopedKey } from '@/common/config/seatConfigKeyCore';

const SELECTION_KEY = 'commandEve.inferenceSelection';
const FAKE_LICENSE = 'CEVE.v2.fake.payload.sig';

/**
 * Build a settings bag the way the renderer's configService persists it for the
 * active seat: the key is seat-physical (un-prefixed for the legacy seat).
 */
function settingsBagWithSelection(selectionValue: string, seatId: string | null): Record<string, unknown> {
  return { [seatScopedKey(SELECTION_KEY, seatId)]: selectionValue };
}

/** The full live chain: backend read → resolved EVE cloud route. */
async function resolveRouteFromBackend() {
  return resolveEveCloudRouteFromBackend({
    readSelection: readInferenceSelectionFromBackend,
    readLicense: () => FAKE_LICENSE,
    functionUrl: 'https://example.supabase.co/functions/v1/eve-inference',
  });
}

describe('EVE inference selection → backend store → route.tier (full chain)', () => {
  beforeEach(() => {
    httpRequestMock.mockReset();
    __resetActiveSeatForTests();
  });
  afterEach(() => {
    __resetActiveSeatForTests();
  });

  it('routes EVE Max (legacy seat) all the way to wire tier "max"', async () => {
    // The picker commits eveTierValue('eve-max') = "command-eve-inference:eve-max".
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), null));

    const route = await resolveRouteFromBackend();

    expect(route?.active).toBe(true);
    // THE assertion that was silently false in the field: Max must NOT degrade.
    expect(route?.tier).toBe('max');
    expect(route?.license).toBe(FAKE_LICENSE);
  });

  it('routes EVE High to wire tier "high"', async () => {
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-high'), null));
    const route = await resolveRouteFromBackend();
    expect(route?.active).toBe(true);
    expect(route?.tier).toBe('high');
  });

  it('routes EVE Standard to wire tier "standard"', async () => {
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-standard'), null));
    const route = await resolveRouteFromBackend();
    expect(route?.active).toBe(true);
    expect(route?.tier).toBe('standard');
  });

  it('routes EVE Max under a NON-legacy seat (seat-physical key) to "max"', async () => {
    // A real seat → the renderer writes the value under the seat-prefixed key.
    // The main-process read MUST resolve the SAME physical key or it falls back
    // to the default (the failure mode this whole fix closes).
    const seatId = 'seat-acme-gmbh';
    setActiveSeatId(seatId);
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), seatId));

    const route = await resolveRouteFromBackend();

    expect(route?.active).toBe(true);
    expect(route?.tier).toBe('max');
  });

  it('a LOCAL (Privat lokal) selection deactivates the EVE cloud route', async () => {
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(localTierValue('local-standard'), null));
    const route = await resolveRouteFromBackend();
    expect(route?.active).toBe(false);
    expect(route?.tier).toBeUndefined();
  });

  it('an EMPTY backend store (the pre-fix ProcessConfig symptom) defaults to "standard", proving Max would have degraded', async () => {
    // This is exactly what the main process saw before the fix: the selection
    // was never in the store it read, so it defaulted to EVE Standard → Flash.
    // We assert the default so the contrast with the "max" cases above is explicit.
    httpRequestMock.mockResolvedValue({});
    const route = await resolveRouteFromBackend();
    expect(route?.active).toBe(true);
    expect(route?.tier).toBe('standard');
  });

  it('a backend read error fails soft (selection undefined → EVE Standard default)', async () => {
    httpRequestMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const route = await resolveRouteFromBackend();
    // readInferenceSelectionFromBackend swallows the error → undefined →
    // resolveEffectiveInferenceSelection → EVE Standard default.
    expect(route?.active).toBe(true);
    expect(route?.tier).toBe('standard');
  });

  it('readInferenceSelectionFromBackend returns the raw persisted picker value', async () => {
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), null));
    const raw = await readInferenceSelectionFromBackend();
    expect(raw).toBe('command-eve-inference:eve-max');
    // Sanity: it queried the backend settings endpoint.
    expect(httpRequestMock).toHaveBeenCalledWith('GET', '/api/settings/client');
  });
});
