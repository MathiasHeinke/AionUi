/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session-list status for the public EVE shell.
 *
 * The sidebar conversation rows used to carry a confusing MIX of leading marks:
 * the agent avatar, a separate blue "completion unread" dot pinned to the right
 * edge, AND the cron indicator's own alarm/pause/attention glyphs swapped IN as
 * the leading icon. Three independent visual systems on one row read as random
 * dots + an orange "attention" glyph + the green-swoosh EVE avatar (which scans
 * like a git-branch mark) — exactly the "broken symbol mix" the founder flagged.
 *
 * This module collapses all of that into ONE semantic status with a fixed
 * color and shape, rendered as a single small mark overlaid on the EVE glyph.
 * Runtime identity stays private; the mark communicates state consistently:
 *
 *   running   → blue ring (animated pulse — a turn is in flight in ANY phase:
 *                       submitted/preparing, thinking, streaming, tool wait)
 *   attention → yellow diamond (needs you: a question/clarify,
 *                       or a paused scheduled task)
 *   error     → red square (the last run failed/was missed)
 *   done      → green circle (a completed run you haven't read)
 *   idle      → none (nothing to flag)
 *
 * `running` IS rendered (since 1.820.5) as an animated, unmistakable mark on
 * every row — background sessions included. The sidebar's "working" truth is
 * the union of runtime.is_processing, local turn tracking, the send-lifecycle
 * gate and the document-preparation store (see useConversationListSync), not
 * only stream frames, so pre-stream phases ("EVE bereitet den Auftrag vor",
 * "EVE denkt") light the row up too.
 */
export type SessionStatus = 'running' | 'attention' | 'error' | 'done' | 'idle';
export type SessionStatusShape = 'ring' | 'diamond' | 'square' | 'circle' | 'none';

/** The cron job status a conversation may carry (subset used by the row). */
export type SessionCronStatus = 'none' | 'active' | 'paused' | 'error' | 'unread';

export interface SessionStatusInput {
  /** A turn is currently streaming/inferring for this conversation. */
  isGenerating: boolean;
  /** A completed run produced output the user has not opened yet. */
  hasCompletionUnread: boolean;
  /** EVE is waiting on the user (a turn ended in `ai_waiting_input` — a question
   * or permission prompt the user hasn't answered yet). */
  isWaitingInput: boolean;
  /** The last chat turn errored / disconnected (terminal stream `error` or
   * `agent_status` error, or a turn that ended in `error`/`stopped`). */
  hasError: boolean;
  /** This conversation's scheduled-task status (`'none'` when not scheduled). */
  cronStatus: SessionCronStatus;
}

/**
 * Derive the single semantic status for a session row.
 *
 * Priority (most urgent / most informative first):
 *   1. running   — an in-flight turn dominates everything.
 *   2. error     — a failed chat turn OR a failed/missed scheduled run is the
 *                  loudest resting state.
 *   3. attention — EVE is waiting on the user (a question/permission), or a
 *                  paused scheduled task needs a decision.
 *   4. done      — a finished run (chat completion OR a scheduled `unread`
 *                  execution) is waiting to be read.
 *   5. idle      — nothing to surface (active-but-quiet cron included).
 */
export function deriveSessionStatus(input: SessionStatusInput): SessionStatus {
  if (input.isGenerating) return 'running';
  if (input.hasError || input.cronStatus === 'error') return 'error';
  if (input.isWaitingInput || input.cronStatus === 'paused') return 'attention';
  if (input.hasCompletionUnread || input.cronStatus === 'unread') return 'done';
  return 'idle';
}

/** CSS color (theme token) for a status, or `null` when no dot should render. */
export function sessionStatusColor(status: SessionStatus): string | null {
  switch (status) {
    case 'running':
      return 'var(--eve-status-running)';
    case 'attention':
      return 'var(--eve-status-attention)';
    case 'error':
      return 'var(--eve-status-error)';
    case 'done':
      return 'var(--eve-status-completed)';
    case 'idle':
    default:
      return null;
  }
}

/** Non-color cue used alongside each status color. */
export function sessionStatusShape(status: SessionStatus): SessionStatusShape {
  switch (status) {
    case 'running':
      return 'ring';
    case 'attention':
      return 'diamond';
    case 'error':
      return 'square';
    case 'done':
      return 'circle';
    case 'idle':
    default:
      return 'none';
  }
}

/** i18n key for the status' accessible label / tooltip. */
export function sessionStatusLabelKey(status: SessionStatus): string {
  return `conversation.status.${status}`;
}
