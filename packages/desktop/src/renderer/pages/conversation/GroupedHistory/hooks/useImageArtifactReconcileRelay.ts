/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.820.3 — turn-end relay for the DURABLE image bind reconcile.
 *
 * Mirrors `useSessionDigestRelay`: the renderer cannot be reached by Main's
 * event sources, so the turn.completed subscription lives here and invokes
 * the Main reconcile provider best-effort. The renderer's own same-turn bind
 * (useAcpMessage finish) stays the fast path; this relay is the durable
 * fallback that recovers an orphan like the R2 child even when the volatile
 * path missed — and it is idempotent by design, so the two racing is a normal
 * `alreadyBound`, never a conflict.
 */

import { useEffect } from 'react';
import { ipcBridge } from '@/common';
import { emitter } from '@/renderer/utils/emitter';
import { isTerminalTurnState } from './useConversationListSync';

export type ImageArtifactReconcileRelayDecision =
  | { action: 'ignore' }
  | { action: 'reconcile'; conversationId: string };

/** Pure decision, unit-tested without a renderer: only a terminal turn state
 * with a usable conversation id reconciles; everything else is ignored. */
export function decideImageArtifactReconcileRelay(event: {
  session_id?: string;
  state?: string;
}): ImageArtifactReconcileRelayDecision {
  const conversationId = String(event?.session_id ?? '').trim();
  if (!conversationId) return { action: 'ignore' };
  if (!isTerminalTurnState(String(event?.state ?? ''))) return { action: 'ignore' };
  return { action: 'reconcile', conversationId };
}

/**
 * Mount-once relay (ConversationHistoryContext, next to the session digest
 * relay). In-flight de-dupe per conversation; every invocation is
 * best-effort and fail-quiet — a reconcile failure must never surface to the
 * chat UI.
 *
 * The terminal refresh is UNCONDITIONAL (race-proof, CoS 1.820.3): another
 * idempotent lane may win the bind first — the list-time reconcile bound the
 * R2 child BEFORE this relay ran, leaving the relay's own summary at
 * bound=0/pendingStaged=0, and a summary-gated refresh silently never came.
 * The store's loadSeq guard and the pending-staged guard upstream keep an
 * unconditional terminal reload cheap; useAcpMessage's finish refresh is
 * unconditional for the same reason. A fresh bind ADDITIONALLY notifies via
 * `command-eve.image-artifacts-changed` from Main itself.
 */
export function useImageArtifactReconcileRelay(): void {
  useEffect(() => {
    const inFlight = new Set<string>();
    const off = ipcBridge.conversation.turnCompleted.on((event) => {
      const decision = decideImageArtifactReconcileRelay(event);
      if (decision.action !== 'reconcile') return;
      const { conversationId } = decision;
      if (inFlight.has(conversationId)) return;
      inFlight.add(conversationId);
      // MAT-1773 (Package B): the same turn-end trigger also hydrates remote
      // video directives — the agent lane hands back a CDN URL and nothing
      // else downloads it. Both reconciles are idempotent and fail-quiet, so
      // racing them against the list-time call is a normal no-op.
      const reconcileImages = ipcBridge.commandEve.imageArtifactReconcile.invoke({ conversationId }).catch(() => {
        // Fail-quiet — the list-time reconcile recovers on the next load.
      });
      const hydrateVideos = ipcBridge.commandEve.videoArtifactHydration.invoke({ conversationId }).catch(() => {
        // Fail-quiet — the list-time hydration recovers on the next load.
      });
      void Promise.allSettled([reconcileImages, hydrateVideos]).finally(() => {
        inFlight.delete(conversationId);
        emitter.emit('commandEve.artifacts.refresh', { conversation_id: conversationId });
      });
    });
    return () => {
      off();
    };
  }, []);
}
