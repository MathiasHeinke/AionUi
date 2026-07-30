/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandEveCloudVisualPolicyReceipt } from './visual/cloudVisualPolicyCore';

export const COMMAND_EVE_MANAGED_VISUAL_TURN_VERSION = 'command-eve-managed-visual-turn/v1' as const;
/** @deprecated Historical wire compatibility only; it no longer authorizes managed visual work. */
export const COMMAND_EVE_MANAGED_VISUAL_TURN_CONSENT_VERSION = 'command-eve-managed-visual-turn-consent/v1' as const;

export type CommandEveManagedVisualTurnTier = 'standard' | 'high' | 'xhigh' | 'max' | 'ultra';
export type CommandEveManagedVisualTurnPreferredTier = Exclude<CommandEveManagedVisualTurnTier, 'standard'>;

export type CommandEveManagedVisualTurnAuthorizationRequest = {
  /** @deprecated Ignored as authority. */
  consentVersion?: typeof COMMAND_EVE_MANAGED_VISUAL_TURN_CONSENT_VERSION;
  flowId?: string;
  visualPolicyReceipt?: CommandEveCloudVisualPolicyReceipt;
  preferredTier?: CommandEveManagedVisualTurnPreferredTier;
  sourceCount: number;
};

export type CommandEveManagedVisualTurnAuthorizationResult = {
  version: typeof COMMAND_EVE_MANAGED_VISUAL_TURN_VERSION;
  ok: boolean;
  reason_code?: string;
  message?: string;
  marker?: string;
  tier?: CommandEveManagedVisualTurnTier;
  expires_at?: string;
};

const TOKEN_PATTERN = '[A-Za-z0-9_-]{43}';
const MARKER_PATTERN = new RegExp(`\\[\\[COMMAND_EVE_MANAGED_VISUAL_TURN:(${TOKEN_PATTERN})\\]\\]`, 'g');

export function commandEveManagedVisualTurnMarker(token: string): string {
  if (!new RegExp(`^${TOKEN_PATTERN}$`).test(token)) {
    throw new Error('Invalid Command EVE managed visual turn token.');
  }
  return `[[COMMAND_EVE_MANAGED_VISUAL_TURN:${token}]]`;
}

export function extractCommandEveManagedVisualTurnToken(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const matches = Array.from(value.matchAll(MARKER_PATTERN));
  return matches.at(-1)?.[1];
}

export function stripCommandEveManagedVisualTurnMarkers(value: string): string {
  return value.replace(MARKER_PATTERN, '').replace(/^\s+/, '');
}

export function resolveCommandEveManagedVisualPreferredTier(
  wireTier: string | undefined
): CommandEveManagedVisualTurnPreferredTier {
  return wireTier === 'xhigh' || wireTier === 'max' || wireTier === 'ultra' ? wireTier : 'high';
}
