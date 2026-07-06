/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.7.3 — a renderer-global registry of which conversations are CURRENTLY
 * streaming a turn, used by the seat-switch guard.
 *
 * Why it exists: a Command EVE seat switch stops + re-spawns the single aioncore
 * backend (a running agent's HERMES_HOME is env-frozen at spawn, so a switch MUST
 * respawn — ISO-1). That kills any in-flight generation on the seat being left,
 * cutting a half-streamed answer + surfacing "Agent killed" (founder-observed).
 * The seat rail lives far from the conversation view and has no access to its
 * streaming state, so this module is the shared signal the guard reads to warn
 * before it would interrupt.
 *
 * MOUNT-INDEPENDENT BY DESIGN (Codex 1.7.3 audit fix, findings #1 + #2): the
 * signal is driven by the GLOBAL ACP response stream (`ipcBridge.acpConversation.
 * responseStream`), not by any mounted conversation component. `start` adds a
 * conversation, `finish`/`error` remove it — and those events flow on the global
 * emitter regardless of which view (if any) is mounted. So a turn that keeps
 * streaming after the user navigates AWAY from its chat is still tracked (the old
 * per-component effect cleared on unmount → a switch silently killed it). The
 * send path also marks generation at submit time, closing the window between
 * "user sent" and the first `start` event (before which the stream is silent).
 *
 * A conversation is removed only on a genuine terminal event, so the flag never
 * gets stuck after a real finish — the same terminal signal the backend already
 * uses to clear the conversation's own running state.
 */

import { ipcBridge } from '@/common';

const generatingConversations = new Set<string>();

// Stream message types that mean "a turn is actively in flight for this
// conversation". `thinking` is handled specially (a done block is not activity).
const ACTIVITY_TYPES = new Set(['start', 'request_trace', 'thought', 'text', 'content', 'acp_permission']);
// Terminal types that end a turn — the ONLY way a conversation leaves the set via
// the stream, so a finished turn never leaves a stuck flag.
const TERMINAL_TYPES = new Set(['finish', 'error']);

/** True while ANY conversation is streaming a turn (a seat switch would interrupt it). */
export function isAnyGenerating(): boolean {
  return generatingConversations.size > 0;
}

/**
 * Mark a conversation as generating at SEND time — before the backend emits its
 * first `start`, during which the response stream is silent. Called by the ACP
 * send path so a fast seat switch in that window still warns.
 */
export function markConversationGenerating(conversationId: string): void {
  if (conversationId) generatingConversations.add(conversationId);
}

/**
 * Clear a conversation whose send FAILED before it ever started streaming (the
 * non-error failure path emits no terminal stream event, so it must be cleared
 * explicitly or the flag would linger).
 */
export function clearConversationGenerating(conversationId: string): void {
  if (conversationId) generatingConversations.delete(conversationId);
}

/**
 * Reduce a single ACP response-stream message into the generating set. Exported
 * so it is unit-testable without the IPC bridge. Add on activity, remove on a
 * terminal event; ignore everything else (bootstrap agent_status, model info,
 * context usage, …) so warmup never registers a phantom turn.
 */
export function applyAcpStreamActivity(message: { type?: string; conversation_id?: string; data?: unknown } | null | undefined): void {
  const conversationId = message?.conversation_id;
  const type = message?.type;
  if (!conversationId || typeof conversationId !== 'string' || !type) return;

  if (TERMINAL_TYPES.has(type)) {
    generatingConversations.delete(conversationId);
    return;
  }
  if (type === 'thinking') {
    // A "done" thinking block is a completed sub-step, not live activity.
    const status = (message?.data as { status?: string } | undefined)?.status;
    if (status !== 'done') generatingConversations.add(conversationId);
    return;
  }
  if (ACTIVITY_TYPES.has(type)) {
    generatingConversations.add(conversationId);
  }
}

let subscribed = false;

/**
 * Attach the global ACP response-stream listener exactly once. Idempotent and
 * best-effort: if the bridge is not ready yet the call is a no-op and a later
 * ensure retries. Call it from any long-lived host (the seat rail, a conversation
 * view) so tracking is live BEFORE any turn starts — a listener attached only at
 * click-time would miss the `start` of an already-running turn.
 */
export function ensureAcpGenerationTracking(): void {
  if (subscribed) return;
  try {
    const stream = ipcBridge?.acpConversation?.responseStream as
      | { on?: (handler: (message: unknown) => void) => unknown }
      | undefined;
    if (!stream || typeof stream.on !== 'function') return;
    stream.on((message: unknown) => applyAcpStreamActivity(message as { type?: string; conversation_id?: string; data?: unknown }));
    subscribed = true;
  } catch {
    // Bridge not ready — a later ensure() from another mount will retry.
  }
}

/** Test-only reset. */
export function clearAllGenerating(): void {
  generatingConversations.clear();
}

// Best-effort eager attach at import (guarded); mounts re-ensure if the bridge
// was not ready here.
ensureAcpGenerationTracking();
