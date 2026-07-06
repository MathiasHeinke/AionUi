/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.7.3 — a tiny renderer-global registry of which conversations are CURRENTLY
 * streaming a turn.
 *
 * Why it exists: a Command EVE seat switch stops + re-spawns the single aioncore
 * backend (a running agent's HERMES_HOME is env-frozen at spawn, so a switch MUST
 * respawn — ISO-1). That kills any in-flight generation on the seat being left,
 * cutting a half-streamed answer + surfacing "Agent killed" (founder-observed).
 * The seat rail lives far from the conversation view and has no access to its
 * streaming state, so this module is the shared signal: the conversation marks
 * itself generating while a turn is in flight, and the seat-switch guard reads it
 * to warn before it would interrupt.
 *
 * Deliberately a plain module singleton (no React, no store): the guard is an
 * imperative point-in-time check at click-time, not reactive UI. Cleared on turn
 * finish AND on conversation unmount so a closed/abandoned turn never leaves a
 * stuck flag that would nag on every future switch.
 */

const generatingConversations = new Set<string>();

/** Mark/unmark a conversation as currently streaming a turn. */
export function setGenerating(conversationId: string, generating: boolean): void {
  if (!conversationId) return;
  if (generating) generatingConversations.add(conversationId);
  else generatingConversations.delete(conversationId);
}

/** True while ANY mounted conversation is streaming a turn (the switch would interrupt it). */
export function isAnyGenerating(): boolean {
  return generatingConversations.size > 0;
}

/** Test/reset helper. */
export function clearAllGenerating(): void {
  generatingConversations.clear();
}
