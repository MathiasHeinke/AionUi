/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE PER-SEAT IMAGE MODEL PREFERENCE core (MAT-1769).
 *
 * The composer's three-way image model selector is a PREFERENCE, not a
 * purchase: it decides which server-resolved model the managed image
 * generation/edit lane uses for this seat. The value lives in the same
 * per-seat settings bag as the cloud visual policy, behind the same strict
 * exact-key discipline (seatConfigKeyCore / cloudVisualPolicyMain), for the
 * same reason: one client's "MAX" must never become another client's bill.
 *
 * Failure doctrine, deliberately different from the visual policy in ONE
 * place: an unknown or malformed STORED VALUE fails closed to the product
 * default ('quality'), not to `unavailable`. A preference has a safe default;
 * a privacy policy does not. Only genuine I/O and seat failures are
 * `unavailable` — and even those resolve to the default tier at the point of
 * use (the generation lane), because the default is defined precisely so a
 * read failure cannot invent a more expensive choice.
 */

import {
  DEFAULT_COMMAND_EVE_IMAGE_MODEL_TIER,
  isCommandEveImageModelTierId,
  type CommandEveImageModelTierId,
} from '../eveImageModelRegistryCore';

/** The only logical settings key that carries this seat's image model choice. */
export const COMMAND_EVE_IMAGE_MODEL_PREFERENCE_KEY = 'commandEve.imageModelPreference' as const;

export const COMMAND_EVE_IMAGE_MODEL_PREFERENCE_VERSION = 'command-eve-image-model-preference/v1' as const;

export type CommandEveImageModelPreferenceSource = 'product_default' | 'stored_explicit';

export type CommandEveImageModelPreferenceState =
  | {
      status: 'resolved';
      tier: CommandEveImageModelTierId;
      source: CommandEveImageModelPreferenceSource;
      seatId: string;
      physicalKey: string;
    }
  | {
      status: 'unavailable';
      reason:
        | 'malformed_settings_response'
        | 'settings_read_failed'
        | 'settings_write_failed'
        | 'seat_resolution_failed'
        | 'seat_changed';
      seatId?: string;
      physicalKey?: string;
    };

export type CommandEveImageModelPreferenceMutationRequest = {
  /** Stale-action fence only. Main always chooses the target from its active seat. */
  expectedSeatId: string;
  tier: CommandEveImageModelTierId;
};

export type CommandEveImageModelPreferenceMutationResult = {
  ok: boolean;
  preference: CommandEveImageModelPreferenceState;
};

/**
 * Interpret one raw stored value. Missing and malformed both resolve to the
 * product default — malformed NEVER passes through, and never blocks a read.
 */
export function resolveCommandEveImageModelPreferenceValue(
  stored: unknown,
  present: boolean
): { tier: CommandEveImageModelTierId; source: CommandEveImageModelPreferenceSource } {
  if (present && isCommandEveImageModelTierId(stored)) {
    return { tier: stored, source: 'stored_explicit' };
  }
  return { tier: DEFAULT_COMMAND_EVE_IMAGE_MODEL_TIER, source: 'product_default' };
}

/** True when a renderer-supplied mutation request is well-formed (seat fence + known tier). */
export function isCommandEveImageModelPreferenceMutationRequest(
  value: unknown
): value is CommandEveImageModelPreferenceMutationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.expectedSeatId === 'string' &&
    record.expectedSeatId.length > 0 &&
    isCommandEveImageModelTierId(record.tier)
  );
}
