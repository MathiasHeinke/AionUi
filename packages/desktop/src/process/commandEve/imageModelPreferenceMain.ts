/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Main-process authority for the PER-SEAT image model preference (MAT-1769).
 *
 * Mirrors the cloudVisualPolicyMain discipline, minus the receipts (a
 * preference never authorizes egress; it only steers it):
 *
 *   - the renderer never names a target seat — Main captures the active seat
 *     and its context revision, and re-proves both across every settings
 *     round trip (`expectedSeatId` on a mutation is a stale-action fence,
 *     never a target);
 *   - the physical key is `seat:<id>:commandEve.imageModelPreference` via
 *     seatScopedKey, with the legacy seat deliberately un-namespaced
 *     (byte-identical to shipped behaviour, zero migration);
 *   - a write is never believed from the PUT response — it is proven by a
 *     second exact-key read under the original captured seat and revision.
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import { seatScopedKey } from '@/common/config/seatConfigKeyCore';
import {
  DEFAULT_COMMAND_EVE_IMAGE_MODEL_TIER,
  type CommandEveImageModelTierId,
} from '@/common/config/eveImageModelRegistryCore';
import {
  COMMAND_EVE_IMAGE_MODEL_PREFERENCE_KEY,
  resolveCommandEveImageModelPreferenceValue,
  type CommandEveImageModelPreferenceMutationResult,
  type CommandEveImageModelPreferenceState,
} from '@/common/config/visual/imageModelPreferenceCore';
import { getActiveSeatContextRevision, getActiveSeatId } from './seatContextCore';

type SeatCapture = {
  seatId: string;
  seatContextRevision: number;
  physicalKey: string;
};

export type CommandEveImageModelPreferenceMainDeps = {
  getActiveSeatId: () => string;
  getActiveSeatContextRevision: () => number;
  readSettings: () => Promise<unknown>;
  writeSettings: (patch: Readonly<Record<string, unknown>>) => Promise<void>;
};

const productionDeps: CommandEveImageModelPreferenceMainDeps = {
  getActiveSeatId,
  getActiveSeatContextRevision,
  readSettings: () => httpRequest<unknown>('GET', '/api/settings/client'),
  writeSettings: (patch) => httpRequest<void>('PUT', '/api/settings/client', patch),
};

function captureSeat(deps: CommandEveImageModelPreferenceMainDeps): SeatCapture | undefined {
  try {
    const seatId = deps.getActiveSeatId();
    const seatContextRevision = deps.getActiveSeatContextRevision();
    return {
      seatId,
      seatContextRevision,
      physicalKey: seatScopedKey(COMMAND_EVE_IMAGE_MODEL_PREFERENCE_KEY, seatId),
    };
  } catch {
    return undefined;
  }
}

function seatStillMatches(capture: SeatCapture, deps: CommandEveImageModelPreferenceMainDeps): boolean {
  try {
    return (
      deps.getActiveSeatId() === capture.seatId && deps.getActiveSeatContextRevision() === capture.seatContextRevision
    );
  } catch {
    return false;
  }
}

function unavailable(
  reason: Extract<CommandEveImageModelPreferenceState, { status: 'unavailable' }>['reason'],
  capture?: SeatCapture
): CommandEveImageModelPreferenceState {
  return {
    status: 'unavailable',
    reason,
    ...(capture ? { seatId: capture.seatId, physicalKey: capture.physicalKey } : {}),
  };
}

function resolveStoredValue(settings: unknown, capture: SeatCapture): CommandEveImageModelPreferenceState {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return unavailable('malformed_settings_response', capture);
  }
  const present = Object.hasOwn(settings, capture.physicalKey);
  const stored = present ? (settings as Record<string, unknown>)[capture.physicalKey] : undefined;
  const { tier, source } = resolveCommandEveImageModelPreferenceValue(stored, present);
  return { status: 'resolved', tier, source, seatId: capture.seatId, physicalKey: capture.physicalKey };
}

async function readPreferenceForCapture(
  capture: SeatCapture,
  deps: CommandEveImageModelPreferenceMainDeps
): Promise<CommandEveImageModelPreferenceState> {
  let settings: unknown;
  try {
    settings = await deps.readSettings();
  } catch {
    return seatStillMatches(capture, deps)
      ? unavailable('settings_read_failed', capture)
      : unavailable('seat_changed', capture);
  }
  if (!seatStillMatches(capture, deps)) return unavailable('seat_changed', capture);
  return resolveStoredValue(settings, capture);
}

/**
 * Resolve only the exact key for one captured Main seat context. Missing and
 * malformed stored values resolve to the product default tier — see the core
 * for why a preference fails closed to its default rather than to unavailable.
 */
export async function readCommandEveImageModelPreference(
  deps: CommandEveImageModelPreferenceMainDeps = productionDeps
): Promise<CommandEveImageModelPreferenceState> {
  const capture = captureSeat(deps);
  if (!capture) return unavailable('seat_resolution_failed');
  return readPreferenceForCapture(capture, deps);
}

/**
 * Persist one tier by storing the exact value under the captured key, then
 * PROVE the persisted state with a second exact-key read. Choosing the
 * product default removes the key (JSON-null deletion contract) so the
 * default stays server-of-record rather than a frozen local copy.
 */
export async function setCommandEveImageModelPreference(
  input: { expectedSeatId: string; tier: CommandEveImageModelTierId },
  deps: CommandEveImageModelPreferenceMainDeps = productionDeps
): Promise<CommandEveImageModelPreferenceMutationResult> {
  const capture = captureSeat(deps);
  if (!capture) return { ok: false, preference: unavailable('seat_resolution_failed') };
  if (input.expectedSeatId !== capture.seatId) {
    return { ok: false, preference: unavailable('seat_changed', capture) };
  }

  try {
    // Choosing the product default deletes the key so the default stays
    // server-of-record rather than a frozen local copy.
    await deps.writeSettings({
      [capture.physicalKey]: input.tier === DEFAULT_COMMAND_EVE_IMAGE_MODEL_TIER ? null : input.tier,
    });
  } catch {
    return {
      ok: false,
      preference: seatStillMatches(capture, deps)
        ? unavailable('settings_write_failed', capture)
        : unavailable('seat_changed', capture),
    };
  }
  if (!seatStillMatches(capture, deps)) {
    return { ok: false, preference: unavailable('seat_changed', capture) };
  }

  const preference = await readPreferenceForCapture(capture, deps);
  const expected = preference.status === 'resolved' && preference.tier === input.tier;
  return { ok: expected, preference };
}
