/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Video submit seam.
 *
 * A caller that wants to start a video calls `requestVideo({ durationSeconds }, run)`
 * and the run fires immediately, resolved to the default tier and its credit
 * estimate.
 *
 * This used to open a blocking cost wall on EVERY generation: the user asked for
 * a video, and the product asked back whether they meant it. That is a second
 * question, not a safety boundary — the request already carried the intent, the
 * same way attaching an image is the authorisation to analyse it.
 *
 * The limit that actually protects money is elsewhere and unaffected: the
 * inference edge function reads `spend_cap_eur_cents` and its debit path refuses
 * on `insufficient`, so an exceeded cap or an empty balance stops the spend at
 * the money boundary regardless of what the renderer shows.
 *
 * The cost does not vanish with the wall. The resolved tier and credit figure are
 * handed to `run`, which weaves them into the dispatched message, so the number
 * stays visible without blocking on it.
 */

import { useCallback } from 'react';
import { buildVideoSubmitGate, estimateVideoCost, type VideoQualityTier } from '@/common/config/videoCostCore';

/** What the caller's submit receives: the resolved tier + estimated credits. */
export type VideoConfirmResolved = { tierId: VideoQualityTier; estimatedCredits: number };

/** The function the caller wants to run for the real submit. */
export type VideoRun = (resolved: VideoConfirmResolved) => void | Promise<void>;
export type VideoCancel = () => void;

export interface VideoCostWallState {
  /**
   * Begin a video request. Resolves the tier and estimate, then runs — no
   * intermediate confirmation.
   *
   * `onCancel` is kept in the signature because a future hard-brake refusal
   * (exceeded cap) still needs a path that restores the composer draft. It is
   * not invoked while the gate allows the request.
   */
  requestVideo: (request: { durationSeconds?: number }, run: VideoRun, onCancel?: VideoCancel) => void;
}

export function useVideoCostWall(): VideoCostWallState {
  const requestVideo = useCallback((request: { durationSeconds?: number }, run: VideoRun, onCancel?: VideoCancel) => {
    const gate = buildVideoSubmitGate();
    const preview = estimateVideoCost({
      tierId: gate.defaultTierId,
      durationSeconds: request.durationSeconds,
    });

    // Fail-closed on anything the gate refuses. Today the gate always allows —
    // the real refusal lives server-side — but a caller that loses its draft
    // silently would be the worse failure, so the restore path stays wired.
    if (!gate.allowed) {
      onCancel?.();
      return;
    }

    void run({ tierId: preview.tier.id, estimatedCredits: preview.estimatedCredits });
  }, []);

  return { requestVideo };
}
