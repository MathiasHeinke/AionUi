/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Video submit seam.
 *
 * A caller that wants to start a video calls
 * `requestVideo({ durationSeconds, tierId }, run)` and the run fires immediately,
 * resolved to the passed tier (or the Fast/720p default) and its credit estimate.
 *
 * `tierId` is the inline quality selection. It arrives as data, NOT as a reason to
 * ask a question: choosing 1080p and pressing send is one decision, not two. The
 * selector is a picker, never a gate — see VideoQualityPill.
 *
 * This used to open a blocking cost wall on EVERY generation: the user asked for
 * a video, and the product asked back whether they meant it. That is a second
 * question, not a safety boundary — the request already carried the intent, the
 * same way attaching an image is the authorisation to analyse it.
 *
 * The limit that actually protects money is elsewhere and unaffected: the
 * inference edge function reserves the spend BEFORE calling upstream
 * (`reservePaidLane` → `canAfford`) and answers 402 on `insufficient_credits` or
 * `spend_cap_exceeded`. That pre-flight gate is the brake — not the ledger
 * reconcile afterwards, which only retries.
 *
 * The cost does not vanish with the wall. The resolved tier and credit figure are
 * handed to `run`, which weaves them into the dispatched message, so the number
 * stays visible without blocking on it.
 */

import { useCallback } from 'react';
import {
  buildVideoSubmitGate,
  estimateVideoCost,
  type VideoModeKind,
  type VideoPlan,
  type VideoQualityTier,
  type VideoSeatCapabilities,
} from '@/common/config/videoCostCore';

/**
 * What the caller's submit receives: the resolved tier, the estimate — and the
 * PLAN both came from.
 *
 * The plan travels rather than being re-derived downstream. The tier alone was
 * enough while one model served each resolution; it stopped being enough the
 * moment reference-to-video put a second model on 720p at double the price, and a
 * submit path that re-derived from the tier would send a request the preview did
 * not describe.
 */
export type VideoConfirmResolved = { tierId: VideoQualityTier; estimatedCredits: number; plan: VideoPlan };

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
  requestVideo: (
    request: {
      durationSeconds?: number;
      tierId?: VideoQualityTier;
      modeKind: VideoModeKind;
      capabilities?: VideoSeatCapabilities;
    },
    run: VideoRun,
    onCancel?: VideoCancel
  ) => void;
}

export function useVideoCostWall(): VideoCostWallState {
  const requestVideo = useCallback(
    (
      request: {
        durationSeconds?: number;
        tierId?: VideoQualityTier;
        modeKind: VideoModeKind;
        capabilities?: VideoSeatCapabilities;
      },
      run: VideoRun,
      onCancel?: VideoCancel
    ) => {
      const gate = buildVideoSubmitGate();
      // An explicit inline selection wins; absent one, the cheaper default. Note
      // `??`, not `||`: the tier is a string union, but a falsy-coalescing bug
      // here would silently downgrade a paid HD request, which is exactly the
      // class of "quietly did something else" this slice exists to remove.
      const preview = estimateVideoCost({
        modeKind: request.modeKind,
        tierId: request.tierId ?? gate.defaultTierId,
        ...(request.durationSeconds === undefined ? {} : { durationSeconds: request.durationSeconds }),
        ...(request.capabilities === undefined ? {} : { capabilities: request.capabilities }),
      });

      // Fail-closed on anything the gate refuses, and on a request with no
      // producible plan at all. Today the gate always allows — the real refusal
      // lives server-side — but a caller that loses its draft silently would be
      // the worse failure, so the restore path stays wired.
      if (!gate.allowed || preview === undefined) {
        onCancel?.();
        return;
      }

      void run({ tierId: preview.tier.id, estimatedCredits: preview.estimatedCredits, plan: preview.plan });
    },
    []
  );

  return { requestVideo };
}
