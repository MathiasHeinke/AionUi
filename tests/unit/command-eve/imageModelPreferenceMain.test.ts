/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The per-seat image model preference, main-process side (MAT-1769).
 *
 * Mirrors the cloudVisualPolicyMain test discipline: strict exact-key reads
 * under the captured seat, stale-seat fences on mutation, and a write that is
 * only believed after a second exact-key read. The ONE deliberate difference
 * from the visual policy is pinned too: an unknown stored value fails closed
 * to the product default ('quality'), never to unavailable — a preference has
 * a safe default, a privacy policy does not.
 */

import { describe, expect, it } from 'vitest';
import {
  readCommandEveImageModelPreference,
  setCommandEveImageModelPreference,
} from '@/process/commandEve/imageModelPreferenceMain';

const SEAT_A = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const SEAT_B = 'ffeeddcc-bbaa-4321-9988-776655443322';
const LOGICAL_KEY = 'commandEve.imageModelPreference';
const KEY_A = `seat:${SEAT_A}:${LOGICAL_KEY}`;

function harness(initial: Record<string, unknown> = {}, seatId = SEAT_A) {
  let activeSeatId = seatId;
  let revision = 1;
  const bag = { ...initial };
  const deps = {
    getActiveSeatId: () => activeSeatId,
    getActiveSeatContextRevision: () => revision,
    readSettings: async (): Promise<unknown> => ({ ...bag }),
    writeSettings: async (patch: Readonly<Record<string, unknown>>): Promise<void> => {
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete bag[key];
        else bag[key] = value;
      }
    },
  };
  return {
    bag,
    deps,
    switchSeat(nextSeatId: string) {
      activeSeatId = nextSeatId;
      revision += 1;
    },
  };
}

describe('strict exact-key image model preference read', () => {
  it('resolves an absent key to the product default', async () => {
    const state = harness();
    await expect(readCommandEveImageModelPreference(state.deps)).resolves.toEqual({
      status: 'resolved',
      tier: 'quality',
      source: 'product_default',
      seatId: SEAT_A,
      physicalKey: KEY_A,
    });
  });

  it('resolves a stored explicit tier', async () => {
    const state = harness({ [KEY_A]: 'max' });
    await expect(readCommandEveImageModelPreference(state.deps)).resolves.toMatchObject({
      status: 'resolved',
      tier: 'max',
      source: 'stored_explicit',
    });
  });

  it('fails closed to the default for an unknown stored value — never passes it through', async () => {
    for (const garbage of ['ultra', 'MAX', 3, true, { tier: 'max' }, null]) {
      const state = harness({ [KEY_A]: garbage });
      await expect(readCommandEveImageModelPreference(state.deps)).resolves.toMatchObject({
        status: 'resolved',
        tier: 'quality',
        source: 'product_default',
      });
    }
  });

  it('scopes the physical key by seat: seat B never reads seat A’s choice', async () => {
    const state = harness({ [KEY_A]: 'max' }, SEAT_B);
    await expect(readCommandEveImageModelPreference(state.deps)).resolves.toMatchObject({
      status: 'resolved',
      tier: 'quality',
      source: 'product_default',
      seatId: SEAT_B,
    });
  });

  it('reports a malformed settings response as unavailable', async () => {
    const state = harness();
    const deps = { ...state.deps, readSettings: async (): Promise<unknown> => ['not', 'a', 'bag'] };
    await expect(readCommandEveImageModelPreference(deps)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'malformed_settings_response',
    });
  });

  it('reports a settings read failure as unavailable', async () => {
    const state = harness();
    const deps = {
      ...state.deps,
      readSettings: async (): Promise<unknown> => {
        throw new Error('io');
      },
    };
    await expect(readCommandEveImageModelPreference(deps)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'settings_read_failed',
    });
  });
});

describe('image model preference mutation', () => {
  it('stores the exact tier under the seat-physical key and proves it by re-read', async () => {
    const state = harness();
    // A non-default tier, so the write is a real stored choice rather than the
    // key-removal path the next test pins. ('fast' was this tier until the
    // 2026-08-18 catalog retired it.)
    const result = await setCommandEveImageModelPreference({ expectedSeatId: SEAT_A, tier: 'seedream-pro' }, state.deps);
    expect(result.ok).toBe(true);
    expect(result.preference).toMatchObject({ status: 'resolved', tier: 'seedream-pro', source: 'stored_explicit' });
    expect(state.bag[KEY_A]).toBe('seedream-pro');
  });

  it('lands a seat that still stores the RETIRED ‘fast’ on the product default', async () => {
    // THE UPGRADE PATH, at the Main boundary: the string is on disk from a
    // build where Schnell existed. It must read back as a real, priceable
    // tier — never an empty selection — and it is NOT reported as an explicit
    // choice, because the word the seat chose no longer exists.
    const state = harness({ [KEY_A]: 'fast' });
    await expect(readCommandEveImageModelPreference(state.deps)).resolves.toMatchObject({
      status: 'resolved',
      tier: 'quality',
      source: 'product_default',
    });
  });

  it('choosing the product default REMOVES the key instead of freezing a copy', async () => {
    const state = harness({ [KEY_A]: 'max' });
    const result = await setCommandEveImageModelPreference({ expectedSeatId: SEAT_A, tier: 'quality' }, state.deps);
    expect(result.ok).toBe(true);
    expect(state.bag).not.toHaveProperty(KEY_A);
    expect(result.preference).toMatchObject({ status: 'resolved', tier: 'quality', source: 'product_default' });
  });

  it('refuses a mutation whose seat fence does not match the active seat', async () => {
    const state = harness();
    const result = await setCommandEveImageModelPreference({ expectedSeatId: SEAT_B, tier: 'max' }, state.deps);
    expect(result.ok).toBe(false);
    expect(result.preference).toMatchObject({ status: 'unavailable', reason: 'seat_changed' });
    expect(state.bag).not.toHaveProperty(KEY_A);
  });

  it('never lands a write on the wrong side of a seat switch', async () => {
    const state = harness();
    const deps = {
      ...state.deps,
      writeSettings: async (patch: Readonly<Record<string, unknown>>): Promise<void> => {
        state.switchSeat(SEAT_B);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete state.bag[key];
          else state.bag[key] = value;
        }
      },
    };
    const result = await setCommandEveImageModelPreference({ expectedSeatId: SEAT_A, tier: 'max' }, deps);
    expect(result.ok).toBe(false);
    expect(result.preference).toMatchObject({ status: 'unavailable', reason: 'seat_changed' });
  });
});
