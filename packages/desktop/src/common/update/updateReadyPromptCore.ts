/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure decision logic for the "update installed — restart now" prompt.
 *
 * Background: a downloaded update used to wait silently for a manual quit, so a
 * stale build could keep running for days while the new version sat installed
 * on disk. This module decides, from updater status events and user actions,
 * whether the restart prompt is visible. It is deliberately free of Electron,
 * DOM and timer APIs so the transitions unit-test without booting the app.
 *
 * The prompt is NEVER permanently dismissible: "Later" only snoozes, and the
 * prompt re-surfaces when the snooze expires (checked on window focus and on a
 * wake-up timer by the caller via the `tick` event). A newly downloaded build
 * always re-surfaces the prompt, even over an active snooze for an older one.
 */

import type { AutoUpdateStatus } from './updateTypes';

/** How long a dismissed restart prompt stays hidden before re-surfacing. */
export const UPDATE_READY_SNOOZE_MS = 4 * 60 * 60 * 1000;

export type UpdateReadyPromptPhase = 'hidden' | 'visible' | 'snoozed';

export type UpdateReadyPromptState = {
  phase: UpdateReadyPromptPhase;
  /** Version of the downloaded build the prompt refers to, when known. */
  version: string | null;
  /** Epoch ms until which a dismissed prompt stays hidden. */
  snoozedUntil: number | null;
};

export const INITIAL_UPDATE_READY_PROMPT_STATE: UpdateReadyPromptState = {
  phase: 'hidden',
  version: null,
  snoozedUntil: null,
};

export type UpdateReadyPromptEvent =
  /** Merged updater status changed (same semantics as mergeAutoUpdateStatus output). */
  | { type: 'status'; status: AutoUpdateStatus }
  /** User chose "Later". */
  | { type: 'dismiss'; now: number }
  /** Window focus or the snooze wake-up timer fired. */
  | { type: 'tick'; now: number };

/**
 * Version of the downloaded, still-installable update, or null when the merged
 * updater state has no downloaded package to offer (nothing found yet, still
 * downloading, or a newer release superseded the downloaded one).
 */
export function resolveInstallableUpdateVersion(status: AutoUpdateStatus | null | undefined): string | null {
  if (!status || status.status !== 'downloaded') return null;
  return status.version ?? null;
}

/**
 * Reduce the prompt state for one event. Pure and total: same inputs always
 * produce the same next state, and unknown/irrelevant events are no-ops.
 */
export function reduceUpdateReadyPrompt(
  state: UpdateReadyPromptState,
  event: UpdateReadyPromptEvent
): UpdateReadyPromptState {
  switch (event.type) {
    case 'status': {
      if (event.status.status !== 'downloaded') {
        // No installable download: either nothing is ready yet, or a newer
        // release replaced the downloaded build (mergeAutoUpdateStatus swaps
        // the state wholesale in that case) — stop prompting for the old one.
        return INITIAL_UPDATE_READY_PROMPT_STATE;
      }
      const version = event.status.version ?? state.version;
      const isNewBuild = state.version === null || (version !== null && version !== state.version);
      if (state.phase === 'snoozed' && !isNewBuild) {
        // Same build, snooze still armed: stay quiet until the snooze expires.
        return state;
      }
      // First sight of a download, or a newer build landed over a snooze:
      // (re-)surface the prompt.
      return { phase: 'visible', version, snoozedUntil: null };
    }
    case 'dismiss': {
      if (state.phase !== 'visible') return state;
      return { ...state, phase: 'snoozed', snoozedUntil: event.now + UPDATE_READY_SNOOZE_MS };
    }
    case 'tick': {
      if (state.phase === 'snoozed' && state.snoozedUntil !== null && event.now >= state.snoozedUntil) {
        return { phase: 'visible', version: state.version, snoozedUntil: null };
      }
      return state;
    }
  }
}
