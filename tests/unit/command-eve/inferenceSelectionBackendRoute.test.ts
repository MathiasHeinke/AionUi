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
  readInferenceLaneStateFromBackendStrict,
  readInferenceSelectionFromBackend,
  resolveEveCloudRouteFromBackend,
} from '@process/commandEve/inferenceSelectionBackendRead';
import { EVE_MAX_ENTITLED_SETTINGS_KEY, eveTierValue, localTierValue } from '@/common/config/eveInferenceCore';
import { __resetActiveSeatForTests, setActiveSeatId } from '@process/commandEve/seatContextCore';
import { seatScopedKey } from '@/common/config/seatConfigKeyCore';

const SELECTION_KEY = 'commandEve.inferenceSelection';
const FAKE_LICENSE = 'CEVE.v2.fake.payload.sig';

/**
 * Build a settings bag the way the renderer's configService persists it for the
 * active seat: the key is seat-physical (un-prefixed for the legacy seat).
 *
 * `maxEntitled` is written to the SAME bag under its own seat-physical key,
 * because that is literally how the renderer publishes it — which is what makes
 * the clamp assertions below exercise the production path instead of a dependency
 * the product never supplies.
 */
function settingsBagWithSelection(
  selectionValue: string,
  seatId: string | null,
  maxEntitled?: boolean
): Record<string, unknown> {
  return {
    [seatScopedKey(SELECTION_KEY, seatId)]: selectionValue,
    ...(maxEntitled === undefined ? {} : { [seatScopedKey(EVE_MAX_ENTITLED_SETTINGS_KEY, seatId)]: maxEntitled }),
  };
}

/**
 * The full live chain, wired EXACTLY as `index.ts` wires it.
 *
 * NOTE what is NOT here: no injected entitlement callback. The earlier version of
 * this helper passed a `readMaxEntitled` dep that the production call site never
 * supplied, so every clamp test passed while the clamp was dead code in the
 * product. The only inputs now are the settings bag and the license — the same
 * two things production has.
 */
async function resolveRouteFromBackend() {
  return resolveEveCloudRouteFromBackend({
    readLaneState: readInferenceLaneStateFromBackendStrict,
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

  it('routes a persisted legacy High down to wire tier "standard" (the migration row, end to end)', async () => {
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-high'), null));
    const route = await resolveRouteFromBackend();
    expect(route?.active).toBe(true);
    expect(route?.tier).toBe('standard');
  });

  it('routes a persisted legacy Sehr-hoch up to wire tier "max"', async () => {
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-xhigh'), null));
    const route = await resolveRouteFromBackend();
    expect(route?.active).toBe(true);
    expect(route?.tier).toBe('max');
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

  it('a backend read error fails loud instead of becoming EVE Standard', async () => {
    httpRequestMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(resolveRouteFromBackend()).rejects.toThrow(
      'Command EVE cloud route unavailable: inference selection could not be read.'
    );
  });

  it('the descriptive best-effort reader still maps a backend error to unknown', async () => {
    httpRequestMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(readInferenceSelectionFromBackend()).resolves.toBeUndefined();
  });

  it('routes a persisted RETIRED rung all the way to wire tier "max"', async () => {
    // Full chain, not a core assertion: a seat that still holds
    // "command-eve-inference:eve-ultra" on the backend must come out of the
    // route resolver as `max`. The server refuses `ultra`, so anything else
    // here would cost that seat every turn.
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-ultra'), null));
    const route = await resolveRouteFromBackend();
    expect(route?.tier).toBe('max');
  });

  it('readInferenceSelectionFromBackend returns the raw persisted picker value', async () => {
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), null));
    const raw = await readInferenceSelectionFromBackend();
    expect(raw).toBe('command-eve-inference:eve-max');
    // Sanity: it queried the backend settings endpoint.
    expect(httpRequestMock).toHaveBeenCalledWith('GET', '/api/settings/client');
  });

  // -------------------------------------------------------------------------
  // BOOT ORDER (the critic's open question).
  //
  // Three main-process consumers read the stored selection BEFORE the renderer
  // hook mounts and can migrate it. So the migration cannot live only in the
  // hook: the FIRST outbound tier of a cold boot has to already be correct.
  // These tests run the main-process chain with NOTHING else initialised — the
  // renderer hook never mounts here — which is exactly the cold-boot window.
  // -------------------------------------------------------------------------

  it('BOOT ORDER: a seeded legacy `eve-ultra` posts "max" on the FIRST outbound turn, not a silent "standard"', async () => {
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-ultra'), null));

    const route = await resolveRouteFromBackend();

    expect(route?.active).toBe(true);
    // The whole point: no renderer has run, nothing has been rewritten on disk,
    // and the first request already carries the migrated tier.
    expect(route?.tier).toBe('max');
    expect(route?.tier).not.toBe('standard');
  });

  it('BOOT ORDER: the seeded value is NOT rewritten by the read path — migration on the wire, persistence elsewhere', async () => {
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-ultra'), null));

    await resolveRouteFromBackend();

    // Only the GET happened. A main-process write here would race the renderer's
    // own write-back and could clobber a fresher choice.
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock).toHaveBeenCalledWith('GET', '/api/settings/client');
  });

  it('BOOT ORDER: a seeded `eve-ultra` under a REAL seat also posts "max" on the first turn', async () => {
    const seatId = 'seat-acme-gmbh';
    setActiveSeatId(seatId);
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-ultra'), seatId));

    const route = await resolveRouteFromBackend();

    expect(route?.tier).toBe('max');
  });

  // -------------------------------------------------------------------------
  // The non-brick clamp, on the LIVE chain rather than in isolation.
  // -------------------------------------------------------------------------

  it('CLAMP (PRODUCTION WIRING): a persisted MAX on a seat the STORE says is unentitled sends on "standard"', async () => {
    // The ONLY inputs are the settings bag and the license — exactly what
    // index.ts supplies. Nothing is injected. If the clamp were dead code again,
    // this fails.
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), null, false));

    const route = await resolveRouteFromBackend();

    // Active — the seat is NOT bricked — but metered on the floor rung.
    expect(route?.active).toBe(true);
    expect(route?.tier).toBe('standard');
    expect(route?.license).toBe(FAKE_LICENSE);
  });

  it('CLAMP (PRODUCTION WIRING): reads the SEAT-PHYSICAL entitlement key, so no seat inherits another seat s plan', async () => {
    const seatId = 'seat-acme-gmbh';
    setActiveSeatId(seatId);
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), seatId, false));
    expect((await resolveRouteFromBackend())?.tier).toBe('standard');

    // The founder/legacy un-prefixed entitlement must NOT be picked up by a real
    // seat: an un-scoped `true` alongside a scoped `false` stays clamped.
    setActiveSeatId(seatId);
    httpRequestMock.mockResolvedValue({
      ...settingsBagWithSelection(eveTierValue('eve-max'), seatId, false),
      [EVE_MAX_ENTITLED_SETTINGS_KEY]: true,
    });
    expect((await resolveRouteFromBackend())?.tier).toBe('standard');
  });

  it('CLAMP (PRODUCTION WIRING): an entitled seat keeps MAX, and an ABSENT flag does not downgrade it', async () => {
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), null, true));
    expect((await resolveRouteFromBackend())?.tier).toBe('max');

    // No entitlement key at all ⇒ unknown ⇒ the server stays the binding gate.
    // Guessing "unentitled" here would silently downgrade a paying seat.
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), null));
    expect((await resolveRouteFromBackend())?.tier).toBe('max');

    // A non-boolean value is unknown too, never a falsy clamp.
    httpRequestMock.mockResolvedValue({
      ...settingsBagWithSelection(eveTierValue('eve-max'), null),
      [EVE_MAX_ENTITLED_SETTINGS_KEY]: 'false',
    });
    expect((await resolveRouteFromBackend())?.tier).toBe('max');
  });

  it('CLAMP (PRODUCTION WIRING): a seeded legacy `eve-ultra` on an unentitled seat lands on "standard", never on nothing', async () => {
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-ultra'), null, false));
    const route = await resolveRouteFromBackend();
    expect(route?.active).toBe(true);
    expect(route?.tier).toBe('standard');
  });

  it('CLAMP: a LOCAL selection is unaffected and still debits no cloud lane', async () => {
    for (const entitled of [true, false, undefined]) {
      httpRequestMock.mockResolvedValue(settingsBagWithSelection(localTierValue('local-high'), null, entitled));
      const route = await resolveRouteFromBackend();
      expect(route?.active).toBe(false);
      expect(route?.tier).toBeUndefined();
      expect(route?.license).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // WIRE-LEVEL REPAIR. A corrupt persisted value used to reach the shim as "no
  // tier" and be answered 500 on EVERY turn, because the repair existed only in
  // the renderer hook — a boot-order race, and absent entirely where the hook
  // never mounts. These assert the repair AT THE WIRE.
  // -------------------------------------------------------------------------

  it('REPAIR: a corrupt EVE-prefixed value still produces a SENDABLE tier, not a 500-every-turn route', async () => {
    for (const corrupt of [
      'command-eve-inference:eve-bogus',
      'command-eve-inference:eve-maximum',
      'command-eve-inference:',
    ]) {
      httpRequestMock.mockResolvedValue(settingsBagWithSelection(corrupt, null));
      const route = await resolveRouteFromBackend();
      expect(route?.active, corrupt).toBe(true);
      // The shim 500s on anything outside the server allow-list, so "defined"
      // is not enough — it has to be the sendable floor rung.
      expect(route?.tier, corrupt).toBe('standard');
    }
  });

  it('REPAIR: a corrupt NON-prefixed value does NOT strand the seat on the local lane forever', async () => {
    // It matched neither prefix, so it silently became "local" and nothing ever
    // repaired it — a seat quietly stuck off the cloud lane with no way back.
    httpRequestMock.mockResolvedValue(settingsBagWithSelection('totally-corrupt-value', null));
    const route = await resolveRouteFromBackend();
    expect(route?.active).toBe(true);
    expect(route?.tier).toBe('standard');
  });

  it('REPAIR: a KNOWN rung is never repaired — verbatim routing is untouched', async () => {
    // The repair must not become a new silent-downgrade path. Anything the
    // registry can name travels exactly as before.
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), null, true));
    expect((await resolveRouteFromBackend())?.tier).toBe('max');
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-standard'), null));
    expect((await resolveRouteFromBackend())?.tier).toBe('standard');
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(localTierValue('local-standard'), null));
    expect((await resolveRouteFromBackend())?.active).toBe(false);
  });
});
