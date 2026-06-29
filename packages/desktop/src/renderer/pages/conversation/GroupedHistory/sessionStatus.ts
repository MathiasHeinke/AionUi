/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session-list status, Claude-Code-style.
 *
 * The sidebar conversation rows used to carry a confusing MIX of leading marks:
 * the agent avatar, a separate blue "completion unread" dot pinned to the right
 * edge, AND the cron indicator's own alarm/pause/attention glyphs swapped IN as
 * the leading icon. Three independent visual systems on one row read as random
 * dots + an orange "attention" glyph + the green-swoosh EVE avatar (which scans
 * like a git-branch mark) — exactly the "broken symbol mix" the founder flagged.
 *
 * This module collapses all of that into ONE semantic status with a fixed
 * color, rendered as a single small dot overlaid on the (kept) agent avatar —
 * the same presence-dot pattern Claude Code / chat apps use. The avatar still
 * tells you WHICH agent; the dot tells you the STATE, consistently:
 *
 *   running   → blue   (a turn is in flight)            -> rgb(var(--primary-6))
 *   attention → orange (needs you: a question/clarify,  -> rgb(var(--warning-6))
 *                       or a paused scheduled task)
 *   error     → red    (the last run failed/was missed) -> rgb(var(--danger-6))
 *   done      → green  (a completed run you haven't read)-> rgb(var(--success-6))
 *   idle      → none   (nothing to flag)
 *
 * `running` is intentionally NOT shown as a dot here — the row already renders a
 * Spin in place of the avatar while generating, which is a clearer "busy" signal
 * than a dot. It is still modeled so callers can branch on it.
 */
export type SessionStatus = 'running' | 'attention' | 'error' | 'done' | 'idle';

/** The cron job status a conversation may carry (subset used by the row). */
export type SessionCronStatus = 'none' | 'active' | 'paused' | 'error' | 'unread';

export interface SessionStatusInput {
  /** A turn is currently streaming/inferring for this conversation. */
  isGenerating: boolean;
  /** A completed run produced output the user has not opened yet. */
  hasCompletionUnread: boolean;
  /** This conversation's scheduled-task status (`'none'` when not scheduled). */
  cronStatus: SessionCronStatus;
}

/**
 * Derive the single semantic status for a session row.
 *
 * Priority (most urgent / most informative first):
 *   1. running   — an in-flight turn dominates everything.
 *   2. error     — a failed/missed scheduled run is the loudest resting state.
 *   3. attention — a paused scheduled task needs a decision.
 *   4. done      — a finished run (chat completion OR a scheduled `unread`
 *                  execution) is waiting to be read.
 *   5. idle      — nothing to surface (active-but-quiet cron included).
 */
export function deriveSessionStatus(input: SessionStatusInput): SessionStatus {
  if (input.isGenerating) return 'running';
  if (input.cronStatus === 'error') return 'error';
  if (input.cronStatus === 'paused') return 'attention';
  if (input.hasCompletionUnread || input.cronStatus === 'unread') return 'done';
  return 'idle';
}

/** CSS color (theme token) for a status, or `null` when no dot should render. */
export function sessionStatusColor(status: SessionStatus): string | null {
  switch (status) {
    case 'running':
      return 'rgb(var(--primary-6))';
    case 'attention':
      return 'rgb(var(--warning-6))';
    case 'error':
      return 'rgb(var(--danger-6))';
    case 'done':
      return 'rgb(var(--success-6))';
    case 'idle':
    default:
      return null;
  }
}

/** i18n key for the status' accessible label / tooltip. */
export function sessionStatusLabelKey(status: SessionStatus): string {
  return `conversation.status.${status}`;
}
