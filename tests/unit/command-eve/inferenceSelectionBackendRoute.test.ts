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
 *     → readInferenceLaneStateFromBackendBestEffort  [seat-physical key, /api/settings/client]
 *     → resolveEffectiveInferenceSelection
 *     → isEveInferenceSelection → resolveWireTierFromSelection
 *     → buildEveCloudRoute → route.tier
 *
 * It is RED against the pre-fix code: with the resolver reading ProcessConfig
 * (which never holds the key), the route tier is `standard` even when the
 * backend store says the user picked EVE Max.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the backend HTTP read so we can simulate the picker's persisted value
// exactly as the renderer's configService.set writes it (seat-physical key in
// the /api/settings/client bag).
const httpRequestMock = vi.fn();
vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: (...args: unknown[]) => httpRequestMock(...args),
}));

import {
  readInferenceLaneStateFromBackendBestEffort,
  resolveEveCloudRouteFromBackend,
} from '@process/commandEve/inferenceSelectionBackendRead';
import { EVE_MAX_ENTITLED_SETTINGS_KEY, eveTierValue, localTierValue } from '@/common/config/eveInferenceCore';
import { __resetActiveSeatForTests, setActiveSeatId } from '@process/commandEve/seatContextCore';
import { CommandEveMaxEntitlementHoldError } from '@process/commandEve/shimPublicError';
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
 * THE PRODUCTION SEAM ITSELF — not a re-implementation of it.
 *
 * The only argument is the license read, which needs Electron's data path. The
 * lane-state reader is NOT injectable any more: `resolveEveCloudRouteFromBackend`
 * owns it, so calling this necessarily runs the REAL
 * `readInferenceLaneStateFromBackendStrict`, and the only thing mocked underneath
 * is `httpRequest` — a genuine external transport.
 *
 * WHY THIS SHAPE. Earlier versions passed their own `readLaneState`. That made the
 * suite structurally blind: production could be unwired and every test stayed
 * green, which is exactly how the clamp shipped dead and how the same defect
 * recurred five times. A test that supplies something production does not is not
 * a gate on production.
 */
async function resolveRouteFromBackend() {
  return resolveEveCloudRouteFromBackend({
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
    // The entitlement is stated (`true`) because since 1.820.2 an UNSTATED one is a
    // HOLD, not a permissive "let it travel" — see the hold suite. These routing
    // cases are about the tier MAPPING, so they supply a proven seat.
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), null, true));

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
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-xhigh'), null, true));
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
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), seatId, true));

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

  it('the descriptive best-effort reader maps a backend error to unknown on BOTH fields', async () => {
    httpRequestMock.mockRejectedValue(new Error('ECONNREFUSED'));
    // Unknown entitlement is what makes the PAINT surfaces fall back to Standard,
    // so an unreadable backend must not leave `maxEntitled` set to anything.
    await expect(readInferenceLaneStateFromBackendBestEffort()).resolves.toEqual({});
  });

  it('routes a persisted RETIRED rung all the way to wire tier "max"', async () => {
    // Full chain, not a core assertion: a seat that still holds
    // "command-eve-inference:eve-ultra" on the backend must come out of the
    // route resolver as `max`. The server refuses `ultra`, so anything else
    // here would cost that seat every turn.
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-ultra'), null, true));
    const route = await resolveRouteFromBackend();
    expect(route?.tier).toBe('max');
  });

  it('the best-effort reader returns the raw picker value AND the entitlement, from ONE GET', async () => {
    // THE PAINT WIRING (1.820.1). This reader used to return the selection string
    // ALONE while fetching `maxEntitled` in the same response and discarding it —
    // which is precisely how the assistant seed came to paint MAX on funding
    // authority it had already read and thrown away. Both fields, one request.
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), null, true));
    expect(await readInferenceLaneStateFromBackendBestEffort()).toEqual({
      selection: 'command-eve-inference:eve-max',
      maxEntitled: true,
    });
    // Sanity: it queried the backend settings endpoint, ONCE.
    expect(httpRequestMock).toHaveBeenCalledWith('GET', '/api/settings/client');
    expect(httpRequestMock).toHaveBeenCalledTimes(1);

    // A store that never wrote the flag stays UNKNOWN — not `false`. Unknown is
    // what the paint path fails closed on and the send path lets travel.
    httpRequestMock.mockClear();
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), null));
    expect(await readInferenceLaneStateFromBackendBestEffort()).toEqual({
      selection: 'command-eve-inference:eve-max',
      maxEntitled: undefined,
    });

    // And a PROVEN-unentitled seat reports false, not unknown.
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), null, false));
    expect((await readInferenceLaneStateFromBackendBestEffort()).maxEntitled).toBe(false);
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
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-ultra'), null, true));

    const route = await resolveRouteFromBackend();

    expect(route?.active).toBe(true);
    // The whole point: no renderer has run, nothing has been rewritten on disk,
    // and the first request already carries the migrated tier.
    expect(route?.tier).toBe('max');
    expect(route?.tier).not.toBe('standard');
  });

  it('BOOT ORDER: the seeded value is NOT rewritten by the read path — migration on the wire, persistence elsewhere', async () => {
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-ultra'), null, true));

    await resolveRouteFromBackend();

    // Only the GET happened. A main-process write here would race the renderer's
    // own write-back and could clobber a fresher choice.
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock).toHaveBeenCalledWith('GET', '/api/settings/client');
  });

  it('BOOT ORDER: a seeded `eve-ultra` under a REAL seat also posts "max" on the first turn', async () => {
    const seatId = 'seat-acme-gmbh';
    setActiveSeatId(seatId);
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-ultra'), seatId, true));

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

  it('CLAMP (PRODUCTION WIRING): an entitled seat keeps MAX, and an ABSENT flag HOLDS rather than guessing', async () => {
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), null, true));
    expect((await resolveRouteFromBackend())?.tier).toBe('max');

    // No entitlement key at all ⇒ UNKNOWN ⇒ the lane is HELD (1.820.2). This case
    // used to expect 'max' on the reasoning that the server is the binding gate.
    // It is not one the client may lean on: letting `max` travel here is paid
    // inference on a seat nobody verified. Substituting 'standard' would be the
    // opposite error — the silent downgrade of a possibly-paying seat — so the
    // resolver refuses to answer at all.
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), null));
    await expect(resolveRouteFromBackend()).rejects.toBeInstanceOf(CommandEveMaxEntitlementHoldError);

    // A non-boolean value is unknown too — held, never quietly resolved either way.
    httpRequestMock.mockResolvedValue({
      ...settingsBagWithSelection(eveTierValue('eve-max'), null),
      [EVE_MAX_ENTITLED_SETTINGS_KEY]: 'false',
    });
    await expect(resolveRouteFromBackend()).rejects.toBeInstanceOf(CommandEveMaxEntitlementHoldError);
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

// ---------------------------------------------------------------------------
// THE RECURRENCE GATE ITSELF.
//
// This defect class has now recurred five times on this ticket: a test that
// passes its own copy of a production dependency, so breaking production leaves
// the suite green. These assertions are about the SHAPE of the wiring, because
// the shape is what kept failing.
// ---------------------------------------------------------------------------
describe('the production wiring cannot be orphaned again', () => {
  const routeModule = fs.readFileSync(
    path.resolve(__dirname, '../../../packages/desktop/src/process/commandEve/inferenceSelectionBackendRead.ts'),
    'utf-8'
  );
  const indexSource = fs.readFileSync(path.resolve(__dirname, '../../../packages/desktop/src/index.ts'), 'utf-8');

  it('resolveEveCloudRouteFromBackend accepts NO lane-state/entitlement dependency', () => {
    // If this becomes injectable again, a test can supply it and the suite goes
    // blind to production exactly as before.
    const signature = routeModule.slice(
      routeModule.indexOf('export async function resolveEveCloudRouteFromBackend'),
      routeModule.indexOf('): Promise<CommandEveEveCloudRoute | undefined> {')
    );
    expect(signature).not.toMatch(/readLaneState/);
    expect(signature).not.toMatch(/readMaxEntitled/);
    expect(signature).not.toMatch(/maxEntitled/);
    // It calls the real reader directly.
    expect(routeModule).toMatch(/const laneState = await readInferenceLaneStateFromBackendStrict\(\)/);
  });

  it('index.ts still calls the resolver, and passes no lane-state reader', () => {
    // Deleting the call is the one thing left that could unwire this, so it is
    // asserted rather than assumed.
    expect(indexSource).toMatch(/return resolveEveCloudRouteFromBackend\(\{/);
    const call = indexSource.slice(
      indexSource.indexOf('return resolveEveCloudRouteFromBackend({'),
      indexSource.indexOf('return resolveEveCloudRouteFromBackend({') + 600
    );
    expect(call).not.toMatch(/readLaneState/);
    expect(call).toMatch(/readLicense/);
  });

  it('the clamp runs through the REAL reader — mocking only the HTTP transport', async () => {
    // The end-to-end proof: nothing of ours is stubbed. The settings bag goes in
    // through the transport, the real reader parses it, and the clamp fires.
    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), null, false));
    expect((await resolveRouteFromBackend())?.tier).toBe('standard');

    httpRequestMock.mockResolvedValue(settingsBagWithSelection(eveTierValue('eve-max'), null, true));
    expect((await resolveRouteFromBackend())?.tier).toBe('max');
  });
});
