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
 * MOUNT-INDEPENDENT BY DESIGN (Codex 1.7.3 audit fixes #1 + #2): the signal is
 * driven by the GLOBAL response streams — ACP (`ipcBridge.acpConversation.
 * responseStream`, the EVE lane) AND native/aionrs (`ipcBridge.conversation.
 * responseStream`) — not by any mounted conversation component. `start` adds a
 * conversation, `finish`/`error` remove it — and those events flow on the global
 * emitters regardless of which view (if any) is mounted. So a turn that keeps
 * streaming after the user navigates AWAY from its chat is still tracked (the old
 * per-component effect cleared on unmount → a switch silently killed it). The
 * send path also marks generation at submit time, closing the window between
 * "user sent" and the first `start` event (before which the stream is silent).
 * A seat switch respawns the single backend and kills turns on EITHER platform,
 * so both must be tracked (see ensureAcpGenerationTracking).
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

let acpSubscribed = false;
let nativeSubscribed = false;

function attachResponseStream(stream: unknown): boolean {
  const emitter = stream as { on?: (handler: (message: unknown) => void) => unknown } | undefined;
  if (!emitter || typeof emitter.on !== 'function') return false;
  emitter.on((message: unknown) => applyAcpStreamActivity(message as { type?: string; conversation_id?: string; data?: unknown }));
  return true;
}

/**
 * Attach the global response-stream listeners exactly once each. Idempotent and
 * best-effort: if a bridge stream is not ready yet the call is a no-op for it and
 * a later ensure retries only the still-missing stream. Call it from any long-lived
 * host (the seat rail, a conversation view) so tracking is live BEFORE any turn
 * starts — a listener attached only at click-time would miss the `start` of an
 * already-running turn.
 *
 * BOTH conversation platforms are tracked (Codex 1.7.3 convergence-2): EVE runs on
 * the ACP stream (ipcBridge.acpConversation.responseStream), while native/aionrs
 * chats run on ipcBridge.conversation.responseStream. Both share the same
 * IResponseMessage shape (start/finish/error/content/…), and a seat switch respawns
 * the SINGLE backend — killing turns on EITHER platform — so the guard must see both
 * or it would silently kill an aionrs turn.
 */
export function ensureAcpGenerationTracking(): void {
  try {
    if (!acpSubscribed && attachResponseStream(ipcBridge?.acpConversation?.responseStream)) acpSubscribed = true;
    if (!nativeSubscribed && attachResponseStream(ipcBridge?.conversation?.responseStream)) nativeSubscribed = true;
  } catch {
    // A bridge stream not ready — a later ensure() from another mount retries it.
  }
}

/**
 * Clear ALL tracked generation because the backend is about to be (re)spawned —
 * a seat switch SIGKILLs the single aioncore backend, so every in-flight turn on
 * the leaving seat dies WITHOUT a terminal stream event (Codex 1.7.3 convergence
 * #1). Without this, a confirmed "switch anyway" would leave the killed
 * conversation stuck in the set and nag on every future switch. Call it at the
 * moment a switch is committed; a genuine new turn on the new seat re-populates
 * the set from the stream.
 */
export function clearGenerationForBackendRespawn(): void {
  generatingConversations.clear();
}

/** Test-only reset. */
export function clearAllGenerating(): void {
  generatingConversations.clear();
}

// Best-effort eager attach at import (guarded); mounts re-ensure if the bridge
// was not ready here.
ensureAcpGenerationTracking();
