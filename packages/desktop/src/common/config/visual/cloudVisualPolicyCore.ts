/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** The only logical settings key that controls managed cloud visual analysis. */
export const COMMAND_EVE_CLOUD_VISUAL_POLICY_KEY = 'commandEve.cloudVisualAnalysisEnabled' as const;

export const COMMAND_EVE_CLOUD_VISUAL_POLICY_VERSION = 'command-eve-cloud-visual-policy/v1' as const;

export type CommandEveCloudVisualPolicyEnabledReason = 'enabled_by_product_default' | 'enabled_explicit_compat';

export type CommandEveCloudVisualPolicyState =
  | {
      status: 'enabled';
      reason: CommandEveCloudVisualPolicyEnabledReason;
      seatId: string;
      physicalKey: string;
    }
  | {
      status: 'disabled';
      reason: 'disabled_by_operator';
      seatId: string;
      physicalKey: string;
    }
  | {
      status: 'unavailable';
      reason:
        | 'malformed_settings_response'
        | 'malformed_stored_value'
        | 'settings_read_failed'
        | 'settings_write_failed'
        | 'seat_resolution_failed'
        | 'seat_changed';
      seatId?: string;
      physicalKey?: string;
    };

/**
 * Opaque, short-lived coordination receipt issued by Electron Main.
 *
 * The receipt is intentionally not a policy decision by itself. Every Main
 * egress boundary must verify its process-local record and reread the exact
 * physical seat policy immediately before network work.
 */
export type CommandEveCloudVisualPolicyReceipt = {
  version: typeof COMMAND_EVE_CLOUD_VISUAL_POLICY_VERSION;
  receiptId: string;
  flowId: string;
  expiresAt: string;
};

export type CommandEveCloudVisualPolicyReceiptRequest = {
  flowId: string;
};

export type CommandEveCloudVisualPolicyReceiptResult =
  | {
      ok: true;
      policy: Extract<CommandEveCloudVisualPolicyState, { status: 'enabled' }>;
      receipt: CommandEveCloudVisualPolicyReceipt;
    }
  | {
      ok: false;
      policy: CommandEveCloudVisualPolicyState;
    };

export type CommandEveCloudVisualPolicyMutationRequest = {
  /** Stale-action fence only. Main always chooses the target from its active seat. */
  expectedSeatId: string;
  enabled: boolean;
};

export type CommandEveCloudVisualPolicyMutationResult = {
  ok: boolean;
  policy: CommandEveCloudVisualPolicyState;
};

/** Conservative renderer-mintable identifier; never used as authority. */
const FLOW_ID_RE = /^[A-Za-z0-9_-]{16,96}$/;
const FLOW_ID_RANDOM_PART_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function isCommandEveCloudVisualFlowId(value: unknown): value is string {
  return typeof value === 'string' && FLOW_ID_RE.test(value);
}

/**
 * Build the renderer-mintable correlation id used by the visual policy bridge.
 *
 * Keep this next to the validator so callers cannot accidentally recreate the
 * 1.822.1 regression where `visual_` plus the default eight-character `uuid()`
 * produced a 15-character id that the preload security boundary rejected.
 * The random part is injected so the shared core stays deterministic in tests;
 * production callers provide `uuid(32)` (128 bits when Web Crypto is present).
 */
export function createCommandEveCloudVisualFlowId(randomPart: string): string {
  const normalizedRandomPart = randomPart.replace(/-/g, '');
  if (!FLOW_ID_RANDOM_PART_RE.test(normalizedRandomPart)) {
    throw new Error('COMMAND_EVE_CLOUD_VISUAL_FLOW_ID_RANDOM_PART_INVALID');
  }
  const flowId = `visual_flow_${normalizedRandomPart}`;
  if (!isCommandEveCloudVisualFlowId(flowId)) {
    throw new Error('COMMAND_EVE_CLOUD_VISUAL_FLOW_ID_INVALID');
  }
  return flowId;
}
