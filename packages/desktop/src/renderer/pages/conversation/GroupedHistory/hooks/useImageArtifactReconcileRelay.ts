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

export type ImageArtifactReconcileRelayDecision = { action: 'ignore' } | { action: 'reconcile'; conversationId: string };

/** Pure decision, unit-tested without a renderer: only a terminal turn state
 * with a usable conversation id reconciles; everything else is ignored. */
export function decideImageArtifactReconcileRelay(event: { session_id?: string; state?: string }): ImageArtifactReconcileRelayDecision {
  const conversationId = String(event?.session_id ?? '').trim();
  if (!conversationId) return { action: 'ignore' };
  if (!isTerminalTurnState(String(event?.state ?? ''))) return { action: 'ignore' };
  return { action: 'reconcile', conversationId };
}

/**
 * What a reconcile summary means for the render surface (pure, unit-tested):
 * ONLY a run that actually BOUND something new warrants a provider refresh —
 * alreadyBound/zero-candidate runs must not tax the UI.
 */
export function reconcileSummaryNeedsRefresh(summary: unknown): boolean {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return false;
  const bound = (summary as Record<string, unknown>).bound;
  return typeof bound === 'number' && bound > 0;
}

/**
 * Mount-once relay (ConversationHistoryContext, next to the session digest
 * relay). In-flight de-dupe per conversation; every invocation is
 * best-effort and fail-quiet — a reconcile failure must never surface to the
 * chat UI. When the durable reconcile BOUND a staged child this turn, the
 * relay emits the artifact refresh itself: the bind changes Main's store,
 * and without this notification the new card would only appear on the next
 * load — the R2 same-turn gap.
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
      void ipcBridge.commandEve.imageArtifactReconcile
        .invoke({ conversationId })
        .then((response) => {
          const summary = response?.data && typeof response.data === 'object'
            ? (response.data as { summary?: unknown }).summary
            : undefined;
          if (reconcileSummaryNeedsRefresh(summary)) {
            emitter.emit('commandEve.artifacts.refresh', { conversation_id: conversationId });
          }
        })
        .catch(() => {
          // Fail-quiet — the list-time reconcile recovers on the next load.
        })
        .finally(() => {
          inFlight.delete(conversationId);
        });
    });
    return () => {
      off();
    };
  }, []);
}
