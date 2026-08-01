/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE THREE STATES OF SIGNED ENTITLEMENT, ASSERTED ON THE SEND PATH ITSELF.
 *
 * THE DEFECT THIS CLOSES. `mayPaintEveMax` already required a positively-known
 * entitlement, so an UNKNOWN seat painted the routine lane. The send path
 * disagreed on purpose: unknown let `max` travel, on the reasoning that the
 * server is the binding gate. Paint Standard, send MAX — the user shown one lane
 * and billed for the other, on a seat nobody had verified. "Upstream will refuse
 * it" is not a spend control the client may lean on.
 *
 * The correction is NOT to flip the send to `standard`: that is the mirror-image
 * failure, the silent downgrade of a seat that may well be paying. Both
 * substitutions are refused. UNKNOWN HOLDS.
 *
 * WHAT THIS FILE ASSERTS, AND WHY IT IS THE WIRE AND NOT A BADGE. Every case runs
 * `resolveEveCloudRouteFromBackend` — the function `index.ts` calls per request to
 * build the real shim route — with NOTHING of ours stubbed. Only `httpRequest`,
 * the genuine external transport, is mocked, so the settings bag goes in exactly
 * as the renderer persists it and the WIRE TIER that comes out is the tier the
 * request would actually carry. A test that only checked a label would prove
 * nothing about the spend.
 *
 * NAMING: `.test.ts`. The `node` vitest project includes `tests/unit/**\/*.test.ts`
 * (NOT `.tsx`) and excludes `*.dom.test.ts`; a `.test.tsx` here would match no
 * project and "pass" by never running.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The ONE external boundary. Everything above it is production code.
const httpRequestMock = vi.fn();
vi.mock('@/common/adapter/httpBridge', () => ({
  httpRequest: (...args: unknown[]) => httpRequestMock(...args),
}));

import { EVE_MAX_ENTITLED_SETTINGS_KEY, eveTierValue, localTierValue } from '@/common/config/eveInferenceCore';
import { resolveEveCloudRouteFromBackend } from '@process/commandEve/inferenceSelectionBackendRead';
import { __resetActiveSeatForTests, setActiveSeatId } from '@process/commandEve/seatContextCore';
import {
  CommandEveMaxEntitlementHoldError,
  EVE_MAX_ENTITLEMENT_HOLD_MESSAGE,
} from '@process/commandEve/shimPublicError';
import { seatScopedKey } from '@/common/config/seatConfigKeyCore';

const SELECTION_KEY = 'commandEve.inferenceSelection';
const SEAT = 'seat-acme-gmbh';
const FAKE_LICENSE = 'CEVE.v2.fake.payload.sig';
/** The user's stated intent, persisted exactly as the composer's MAX toggle writes it. */
const PERSISTED_MAX_SELECTION = eveTierValue('eve-max');

/**
 * The backend settings bag for the active seat, in the renderer's own shape.
 *
 * `maxEntitled` is OMITTED when `undefined` — which is precisely what "unknown"
 * looks like on disk: a fresh install, a boot before the first renderer mount, or
 * a settings row that could not be read.
 */
function settingsBag(selection: string, maxEntitled?: boolean): Record<string, unknown> {
  return {
    [seatScopedKey(SELECTION_KEY, SEAT)]: selection,
    ...(maxEntitled === undefined ? {} : { [seatScopedKey(EVE_MAX_ENTITLED_SETTINGS_KEY, SEAT)]: maxEntitled }),
  };
}

/** The PRODUCTION seam. The lane-state reader is not injectable — this runs the real one. */
async function resolveRoute() {
  return resolveEveCloudRouteFromBackend({
    readLicense: () => FAKE_LICENSE,
    functionUrl: 'https://example.supabase.co/functions/v1/eve-inference',
  });
}

/** The wire tier a turn WOULD carry right now, or the hold that stops it. */
async function wireTierOrHold(): Promise<string> {
  try {
    const route = await resolveRoute();
    return route?.active === true ? String(route.tier) : 'no-cloud-route';
  } catch (error) {
    if (error instanceof CommandEveMaxEntitlementHoldError) return 'HELD';
    throw error;
  }
}

describe('MAX entitlement — the three states, on the wire', () => {
  beforeEach(() => {
    httpRequestMock.mockReset();
    __resetActiveSeatForTests();
    setActiveSeatId(SEAT);
  });
  afterEach(() => {
    __resetActiveSeatForTests();
  });

  it('(a) UNKNOWN: does NOT send MAX, does not substitute Standard, and no request is built', async () => {
    httpRequestMock.mockResolvedValue(settingsBag(PERSISTED_MAX_SELECTION, undefined));

    // THE SPEND ASSERTION. Not "the badge is off" — the resolver produces no route
    // at all, so there is nothing for the shim to POST.
    await expect(resolveRoute()).rejects.toBeInstanceOf(CommandEveMaxEntitlementHoldError);
    expect(await wireTierOrHold()).toBe('HELD');

    // Stated the other way round, because "not max" alone would also be satisfied
    // by a silent downgrade — which is the failure in the opposite direction.
    const outcome = await wireTierOrHold();
    expect(outcome, 'MAX must not travel on an unverified seat').not.toBe('max');
    expect(outcome, 'and Standard must not be substituted behind the user').not.toBe('standard');

    // A non-boolean stored value is unknown too, never a falsy answer.
    httpRequestMock.mockResolvedValue({
      ...settingsBag(PERSISTED_MAX_SELECTION, undefined),
      [seatScopedKey(EVE_MAX_ENTITLED_SETTINGS_KEY, SEAT)]: 'false',
    });
    expect(await wireTierOrHold()).toBe('HELD');

    // A FORGOTTEN entitlement key on the whole bag holds as well.
    httpRequestMock.mockResolvedValue({ [seatScopedKey(SELECTION_KEY, SEAT)]: PERSISTED_MAX_SELECTION });
    expect(await wireTierOrHold()).toBe('HELD');
  });

  it('(a2) the HOLD is a NAMED, non-provider refusal — not a generic 500 and not a lane switch', async () => {
    httpRequestMock.mockResolvedValue(settingsBag(PERSISTED_MAX_SELECTION, undefined));

    const error = await resolveRoute().then(
      () => undefined,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(CommandEveMaxEntitlementHoldError);
    const message = (error as Error).message;
    expect(message).toBe(EVE_MAX_ENTITLEMENT_HOLD_MESSAGE);
    // NON-PROVIDER, enforced rather than eyeballed: no vendor/model slug shape, no
    // known lane vocabulary beyond the product's own word "MAX".
    expect(message).not.toMatch(/[a-z0-9]+\/[a-z0-9.-]+/i);
    for (const forbidden of ['deepseek', 'glm', 'gemini', 'flash', 'ollama', 'gemma', 'openrouter', 'anthropic']) {
      expect(message.toLowerCase()).not.toContain(forbidden);
    }
    // And it did NOT quietly become the local lane, which would re-lane a cloud
    // turn onto the user's own machine without telling anyone.
    expect(message).not.toContain('local');
  });

  it('(b) UNKNOWN → TRUE: the same persisted selection now sends MAX', async () => {
    httpRequestMock.mockResolvedValue(settingsBag(PERSISTED_MAX_SELECTION, undefined));
    expect(await wireTierOrHold()).toBe('HELD');

    // The entitlement resolves positively. Nothing else changed.
    httpRequestMock.mockResolvedValue(settingsBag(PERSISTED_MAX_SELECTION, true));

    const route = await resolveRoute();
    expect(route?.active).toBe(true);
    expect(route?.tier).toBe('max');
    expect(route?.license).toBe(FAKE_LICENSE);
  });

  it('(c) UNKNOWN → FALSE: returns to Standard and SENDS Standard — the seat is never bricked', async () => {
    httpRequestMock.mockResolvedValue(settingsBag(PERSISTED_MAX_SELECTION, undefined));
    expect(await wireTierOrHold()).toBe('HELD');

    httpRequestMock.mockResolvedValue(settingsBag(PERSISTED_MAX_SELECTION, false));

    const route = await resolveRoute();
    // Active, metered on the floor rung: submission is RESTORED, not held.
    expect(route?.active).toBe(true);
    expect(route?.tier).toBe('standard');
    expect(await wireTierOrHold()).not.toBe('HELD');
  });

  it('(d) the persisted MAX selection is UNCHANGED throughout — intent is kept, never rewritten', async () => {
    // The exact bytes the composer wrote, frozen so a mutation anywhere in the
    // chain is a TypeError rather than a silently-accepted rewrite.
    const stored = Object.freeze(settingsBag(PERSISTED_MAX_SELECTION, undefined));
    httpRequestMock.mockResolvedValue(stored);

    expect(await wireTierOrHold()).toBe('HELD');
    // Repeat the held turn: a hold must not "resolve itself" by editing the store.
    expect(await wireTierOrHold()).toBe('HELD');

    // The selection is still MAX, byte for byte.
    expect(stored[seatScopedKey(SELECTION_KEY, SEAT)]).toBe(PERSISTED_MAX_SELECTION);
    expect(stored).toEqual({ [seatScopedKey(SELECTION_KEY, SEAT)]: PERSISTED_MAX_SELECTION });

    // ...and nothing was written back. Only GETs happened — a PUT here would race
    // the renderer and could clobber a fresher choice, and a rewrite to Standard
    // is exactly the silent downgrade this contract forbids.
    for (const call of httpRequestMock.mock.calls) {
      expect(call[0], 'the hold must never write to the settings store').toBe('GET');
    }
    expect(httpRequestMock).toHaveBeenCalledWith('GET', '/api/settings/client');

    // And the intent survives INTO the resolution: the very same stored string is
    // what lights MAX up again once the entitlement lands.
    httpRequestMock.mockResolvedValue(settingsBag(PERSISTED_MAX_SELECTION, true));
    expect((await resolveRoute())?.tier).toBe('max');
  });

  it('nothing else is held: Standard and the local lane are unaffected by an unknown entitlement', async () => {
    // A hold that caught the floor rung would brick every seat on a cold boot, and
    // a hold on the local lane would block a lane that costs nothing at all.
    httpRequestMock.mockResolvedValue(settingsBag(eveTierValue('eve-standard'), undefined));
    expect((await resolveRoute())?.tier).toBe('standard');

    httpRequestMock.mockResolvedValue(settingsBag(localTierValue('local-standard'), undefined));
    expect((await resolveRoute())?.active).toBe(false);

    // An absent selection (fresh seat) defaults to Standard and sends.
    httpRequestMock.mockResolvedValue({});
    expect((await resolveRoute())?.tier).toBe('standard');
  });

  it('a persisted LEGACY rung is migrated first and only then held', async () => {
    // eve-ultra migrates onto MAX, so it inherits the hold — otherwise the
    // fail-closed rule would have a hole shaped like an old persisted value.
    httpRequestMock.mockResolvedValue(settingsBag(eveTierValue('eve-ultra'), undefined));
    expect(await wireTierOrHold()).toBe('HELD');

    httpRequestMock.mockResolvedValue(settingsBag(eveTierValue('eve-ultra'), true));
    expect((await resolveRoute())?.tier).toBe('max');

    httpRequestMock.mockResolvedValue(settingsBag(eveTierValue('eve-ultra'), false));
    expect((await resolveRoute())?.tier).toBe('standard');

    // eve-high migrates DOWN to Standard, so it is never held.
    httpRequestMock.mockResolvedValue(settingsBag(eveTierValue('eve-high'), undefined));
    expect((await resolveRoute())?.tier).toBe('standard');
  });

  it('the entitlement is read SEAT-PHYSICALLY — no seat inherits another seat s proof', async () => {
    // An un-scoped (founder/legacy) `true` alongside a missing scoped value must
    // not resolve THIS seat's unknown. Inheriting a proof is how one tenant would
    // start spending on another tenant's entitlement.
    httpRequestMock.mockResolvedValue({
      ...settingsBag(PERSISTED_MAX_SELECTION, undefined),
      [EVE_MAX_ENTITLED_SETTINGS_KEY]: true,
    });
    expect(await wireTierOrHold()).toBe('HELD');
  });
});
