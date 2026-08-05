/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The MAX composer glow STATE MODEL (MAT-1773, founder decision 2026-08-05).
 *
 * One pure mapping from the EXISTING runtime/activity truth to the composer's
 * visual state. There is deliberately no parallel state source: the input is
 * the same `AcpRuntimeActivityPhase` the runtime status footer reads, plus
 * `maxActive` from the main-process authority (never the stored intent).
 *
 *   maxActive = false                      -> off        (standard look, exactly)
 *   phase submitting | connecting          -> start-stau (gold shimmer circles the border)
 *   phase thinking | tool_wait | heartbeat_only -> denk-puls (heartbeat double-pulse)
 *   phase streaming | ui_backlog           -> stream     (calm left-to-right flow)
 *   anything else (idle/ready/done/error)  -> armed      (slow breath)
 *
 * IGNITION is not a state here: it is the one-shot ~300ms sweep on the
 * false -> true `maxActive` edge, stamped by EveMaxToggle and animated purely
 * in CSS. An unknown/future phase maps to `armed` — MAX on with nothing proven
 * running is the resting state, and an unmapped phase must never kill the glow.
 */

import type { AcpRuntimeActivityPhase } from '@/renderer/pages/conversation/platforms/acp/useAcpMessage';

export type ComposerGlowState = 'armed' | 'start-stau' | 'denk-puls' | 'stream' | 'off';

/** The attribute the composer stylesheet keys the glow state on. Absent = off. */
export const COMPOSER_GLOW_ATTRIBUTE = 'data-eve-glow';
/** One-shot ignition sweep marker, stamped on the false→true MAX edge only. */
export const COMPOSER_MAX_IGNITION_ATTRIBUTE = 'data-eve-max-ignition';

/** How long the ignition marker stays stamped (sweep is 300ms; small margin). */
export const COMPOSER_MAX_IGNITION_MS = 350;

export function resolveComposerGlowState(input: {
  maxActive: boolean;
  phase: AcpRuntimeActivityPhase | string;
}): ComposerGlowState {
  if (!input.maxActive) return 'off';
  switch (input.phase) {
    case 'submitting':
    case 'connecting':
      return 'start-stau';
    case 'thinking':
    case 'tool_wait':
    case 'heartbeat_only':
      return 'denk-puls';
    case 'streaming':
    case 'ui_backlog':
      return 'stream';
    default:
      // idle / ready / done / error / anything unmapped: MAX on, nothing
      // proven running — the armed resting state.
      return 'armed';
  }
}
