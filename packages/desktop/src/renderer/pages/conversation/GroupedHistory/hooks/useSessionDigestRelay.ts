/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * L3 SESSION-DIGEST RENDERER RELAY (v1.4 T5).
 *
 * WHY A RENDERER RELAY. `turn.completed` is a backend WS event that ONLY the renderer
 * receives (the httpBridge WS is a renderer singleton; the main process has no WS
 * client — a main-side subscription would silently never fire). So the TRIGGER for a
 * session digest has to originate in the renderer. This module is that trigger: it
 * listens to the same turn.completed stream useConversationListSync does, but its ONLY
 * job is to decide WHEN a conversation has gone quiet enough to summarize, then hand a
 * bare { conversation_id } to the MAIN-side digest writer over IPC
 * (command-eve.session-digest). All the actual work — transcript fetch, local
 * inference, the per-seat brain write — happens in main; the renderer never sees a
 * transcript or touches Ollama.
 *
 * DEBOUNCE POLICY (spec §4). Per conversation:
 *   • a NON-terminal turn (ai_generating / ai_waiting_confirmation / initializing /
 *     'unknown') ARMS a quiet-window timer (SESSION_DIGEST_QUIET_MS); a later event
 *     RESETS it — so a digest fires only after the conversation has been idle;
 *   • a TERMINAL turn (ai_waiting_input / stopped / error — the SAME exported predicate
 *     useConversationListSync uses, so the two never drift) fires the digest
 *     IMMEDIATELY (the turn is done for now) and clears any pending timer.
 * The state-default falle is inherited from isTerminalTurnState: a missing state that
 * maps to 'unknown' is NON-terminal, so it only arms the debounce, never an immediate
 * flush.
 *
 * WHY NOT NEST THIS IN useConversationListSync. That store is a module singleton with
 * its own concerns (the sidebar's resting flags). The digest relay has an independent
 * lifecycle (per-conversation timers, its own in-flight guard) and must not entangle
 * the sidebar store — so it is a SEPARATE hook mounted beside it.
 *
 * HONEST v1.4 LIMIT. This only relays while the window is open. Window closed ⇒ no
 * relay ⇒ the digest is produced at the NEXT anchor (a later turn, or the pre-switch
 * flush of an already-running run). There is NO guarantee of one digest per turn — the
 * seat-switch flush and quit path are documented in sessionDigestCore.
 */

import { ipcBridge } from '@/common';
import { useEffect } from 'react';
import { isTerminalTurnState } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';

/** Quiet window (ms) before a non-terminal, still-active conversation is digested. */
export const SESSION_DIGEST_QUIET_MS = 90_000;

/** The decision the relay makes for a single turn.completed event. */
export type SessionDigestRelayDecision =
  | { action: 'flush_now' } // terminal state — digest immediately
  | { action: 'arm_debounce' } // non-terminal — (re)start the quiet-window timer
  | { action: 'ignore' }; // no usable conversation id

/**
 * PURE decision for one turn.completed event (unit-tested without React/timers):
 *   • no session id                       → ignore
 *   • terminal state (isTerminalTurnState) → flush_now
 *   • otherwise (incl. 'unknown')          → arm_debounce
 */
export function decideSessionDigestRelay(event: { session_id?: string; state?: string }): SessionDigestRelayDecision {
  const conversationId = String(event?.session_id ?? '').trim();
  if (!conversationId) return { action: 'ignore' };
  if (isTerminalTurnState(String(event?.state ?? ''))) return { action: 'flush_now' };
  return { action: 'arm_debounce' };
}

/**
 * Mount-once relay. Subscribes to turn.completed, debounces per conversation, and
 * invokes the main-side digest writer. In-flight de-dupe: a conversation already being
 * digested is not re-invoked until its run resolves (a fast terminal event right after
 * an arm can't double-fire). All invocation is best-effort + fail-quiet — a digest
 * failure must never disturb the chat UI.
 */
export function useSessionDigestRelay(): void {
  useEffect(() => {
    // Per-conversation quiet-window timers (armed by non-terminal turns).
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    // Conversations with an in-flight main-side digest (de-dupe guard).
    const inFlight = new Set<string>();

    const clearTimer = (conversationId: string) => {
      const t = timers.get(conversationId);
      if (t) {
        clearTimeout(t);
        timers.delete(conversationId);
      }
    };

    const fireDigest = (conversationId: string) => {
      clearTimer(conversationId);
      if (inFlight.has(conversationId)) return; // one run at a time per conversation
      inFlight.add(conversationId);
      void ipcBridge.commandEve.sessionDigest
        .invoke({ conversation_id: conversationId })
        .catch(() => {
          // Fail-quiet — a digest is best-effort and must never surface to the UI.
        })
        .finally(() => {
          inFlight.delete(conversationId);
        });
    };

    const off = ipcBridge.conversation.turnCompleted.on((event) => {
      const decision = decideSessionDigestRelay(event);
      if (decision.action === 'ignore') return;
      const conversationId = String(event.session_id ?? '').trim();
      if (decision.action === 'flush_now') {
        fireDigest(conversationId);
        return;
      }
      // arm_debounce: (re)start the quiet-window timer for this conversation.
      clearTimer(conversationId);
      timers.set(
        conversationId,
        setTimeout(() => {
          timers.delete(conversationId);
          fireDigest(conversationId);
        }, SESSION_DIGEST_QUIET_MS)
      );
    });

    return () => {
      off?.();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      inFlight.clear();
    };
  }, []);
}
