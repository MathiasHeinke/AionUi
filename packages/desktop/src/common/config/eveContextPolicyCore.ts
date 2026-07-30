/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE deliberately operates below provider-advertised 1M+ windows.
 * A stable 256K ceiling gives Hermes enough room for long agentic work while
 * keeping compaction quality, latency, and prompt-cache reuse predictable.
 */
export const COMMAND_EVE_OPERATIONAL_CONTEXT_LIMIT = 262_144;
export const COMMAND_EVE_CONTEXT_COMPRESSION_THRESHOLD = 0.75;
export const COMMAND_EVE_CONTEXT_POLICY_VERSION = 'command-eve-context-policy/v1' as const;

/**
 * Policy-v1 headroom contract. The paid route intentionally omits output-token
 * fields, so the cloud value is a declared planning bound rather than a request
 * clamp. Local tiers remain hard-clamped to at most 8K by runtimeBootstrapCore.
 */
export const COMMAND_EVE_CLOUD_DECLARED_MAX_OUTPUT_TOKENS = 8_192;
export const COMMAND_EVE_LOCAL_DECLARED_MAX_OUTPUT_TOKENS = 8_192;
export const COMMAND_EVE_CONTEXT_COMPRESSION_MARGIN_TOKENS = 4_096;

export type CommandEveContextLane = 'cloud' | 'local';

export interface CommandEveContextPolicy {
  version: typeof COMMAND_EVE_CONTEXT_POLICY_VERSION;
  lane: CommandEveContextLane;
  hard_limit_tokens: number;
  compression_threshold: number;
  compression_threshold_tokens: number;
}

export interface CommandEveContextHeadroomContract {
  declared_max_output_tokens: number;
  compression_margin_tokens: number;
  available_headroom_tokens: number;
  required_headroom_tokens: number;
}

function normalizeLocalContextLimit(value: number): number {
  if (!Number.isFinite(value)) return 65_536;
  return Math.max(4_096, Math.min(COMMAND_EVE_OPERATIONAL_CONTEXT_LIMIT, Math.floor(value)));
}

export function buildCommandEveContextPolicy(
  lane: CommandEveContextLane,
  localContextLimit = 65_536
): CommandEveContextPolicy {
  const hardLimit =
    lane === 'cloud' ? COMMAND_EVE_OPERATIONAL_CONTEXT_LIMIT : normalizeLocalContextLimit(localContextLimit);
  return {
    version: COMMAND_EVE_CONTEXT_POLICY_VERSION,
    lane,
    hard_limit_tokens: hardLimit,
    compression_threshold: COMMAND_EVE_CONTEXT_COMPRESSION_THRESHOLD,
    compression_threshold_tokens: Math.floor(hardLimit * COMMAND_EVE_CONTEXT_COMPRESSION_THRESHOLD),
  };
}

export function buildCommandEveContextHeadroomContract(
  policy: CommandEveContextPolicy
): CommandEveContextHeadroomContract {
  const declaredMaxOutputTokens =
    policy.lane === 'cloud'
      ? COMMAND_EVE_CLOUD_DECLARED_MAX_OUTPUT_TOKENS
      : COMMAND_EVE_LOCAL_DECLARED_MAX_OUTPUT_TOKENS;
  const availableHeadroomTokens = policy.hard_limit_tokens - policy.compression_threshold_tokens;
  const requiredHeadroomTokens = declaredMaxOutputTokens + COMMAND_EVE_CONTEXT_COMPRESSION_MARGIN_TOKENS;

  if (availableHeadroomTokens < requiredHeadroomTokens) {
    throw new Error('COMMAND_EVE_CONTEXT_HEADROOM_UNSAFE');
  }

  return {
    declared_max_output_tokens: declaredMaxOutputTokens,
    compression_margin_tokens: COMMAND_EVE_CONTEXT_COMPRESSION_MARGIN_TOKENS,
    available_headroom_tokens: availableHeadroomTokens,
    required_headroom_tokens: requiredHeadroomTokens,
  };
}
