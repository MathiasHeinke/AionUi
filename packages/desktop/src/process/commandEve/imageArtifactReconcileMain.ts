/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.820.3 — MAIN-side durable reconciliation of staged image binds.
 *
 * The renderer's same-turn bind is a fast path over a volatile map; this is
 * the authority of record. It reads the conversation's PERSISTED transcript
 * (the same loopback messages API the session digest already uses — no raw
 * database coupling), extracts completed managed-image tool results with the
 * strict pure extractor, and binds each staged handle idempotently. It runs
 * at turn end (turnCompleted relay) and before the image artifact list is
 * served (conversation load recovery), so an orphan like the R2 child is
 * recovered by the next list instead of needing a manual IPC call.
 *
 * Fail-quiet by contract: a fetch failure, a parse miss, or a refused bind
 * (unknown / expired / malformed / conversation-mismatch handle) is COLLECTED
 * and reported in the result — and logged ONCE per run as a bounded summary —
 * never thrown into a turn or a list. `alreadyBound` is a normal outcome (the
 * renderer fast path may legitimately win the race). NO provider call and NO
 * debit path exists here: binding only flips a staged record's display state.
 */

import { extractImageBindCandidatesFromTranscript } from '@/common/config/imageArtifactReconcileCore';
import { bindStagedImageArtifact, type ImageArtifactBindResult } from './imageArtifactStore';

export type ImageArtifactReconcileSummary = {
  conversationId: string;
  candidates: number;
  bound: number;
  alreadyBound: number;
  refused: Array<{ toolCallId: string; reason: string }>;
  transcriptFetched: boolean;
  /** Staged entries the guard found; 0 means the transcript was never fetched. */
  pendingStaged: number;
};

export interface ImageArtifactReconcileDeps {
  /** The persisted transcript window (session-digest pattern: loopback GET). */
  fetchTranscript: (conversationId: string, window: number) => Promise<unknown>;
  bind: typeof bindStagedImageArtifact;
  log: (line: string) => void;
  /** Bounded transcript window (message count). */
  window?: number;
  /**
   * Cheap pending-staged probe (store scan, no transcript). When it reports 0
   * there is PROVABLY nothing to bind and the transcript fetch is skipped
   * entirely — the artifact list runs on every conversation load and history
   * refresh, so an unconditional full-mode fetch would tax every ordinary
   * load. Absent => the reconcile always fetches (unit-test convenience);
   * production always injects the store probe.
   */
  countPendingStaged?: (dataPath: string) => number;
  /**
   * Same-turn insertion: invoked ONCE with the canonical conversation id when
   * this run freshly bound at least one record — from WHICHEVER lane won the
   * race (turn-end relay, list-time reconcile, manual). Renderer-side turn
   * events have proven unreliable on this lane; a fresh bind in Main is the
   * one signal that cannot be missed. alreadyBound-only runs do not notify
   * (the terminal refresh in the relay covers that case unconditionally).
   */
  onFreshBind?: (conversationId: string) => void;
}

// Bounded to the recent turn window: a staged handle lives 30 minutes, so a
// candidate older than this window could never be bound anyway.
const DEFAULT_WINDOW = 50;

export async function reconcileConversationImageArtifactBinds(
  dataPath: string,
  conversationId: string,
  deps: ImageArtifactReconcileDeps
): Promise<ImageArtifactReconcileSummary> {
  const summary: ImageArtifactReconcileSummary = {
    conversationId,
    candidates: 0,
    bound: 0,
    alreadyBound: 0,
    refused: [],
    transcriptFetched: false,
    pendingStaged: -1,
  };
  if (typeof conversationId !== 'string' || conversationId.trim().length === 0) return summary;

  // The cheap guard FIRST: nothing pending anywhere => nothing can bind here,
  // and the (full-mode, deliberately small) transcript window is never read.
  if (deps.countPendingStaged) {
    try {
      summary.pendingStaged = deps.countPendingStaged(dataPath);
    } catch {
      summary.pendingStaged = -1;
    }
    if (summary.pendingStaged === 0) return summary;
  }

  let items: unknown = [];
  try {
    items = await deps.fetchTranscript(conversationId, deps.window ?? DEFAULT_WINDOW);
    summary.transcriptFetched = true;
  } catch {
    // A failed fetch is a quiet no-op — transcriptFetched stays false so the
    // caller can tell "nothing to do" from "could not look".
  }
  const candidates = extractImageBindCandidatesFromTranscript(items);
  summary.candidates = candidates.length;

  for (const candidate of candidates) {
    let result: ImageArtifactBindResult;
    try {
      result = deps.bind(dataPath, {
        conversationId,
        handle: candidate.handle,
        toolCallId: candidate.toolCallId,
      });
    } catch {
      summary.refused.push({ toolCallId: candidate.toolCallId, reason: 'bind-error' });
      continue;
    }
    if (result.ok) {
      if (result.alreadyBound) summary.alreadyBound += 1;
      else summary.bound += 1;
    }
    if (result.ok === false) {
      summary.refused.push({ toolCallId: candidate.toolCallId, reason: result.reason });
    }
  }

  // A fresh bind from ANY lane notifies exactly once — the turn-end relay is
  // not the only path that can win the race (the list-time reconcile bound
  // the R2 child first, and the renderer never learned of it in-session).
  // Isolated best-effort: a throwing notifier must not reject this fail-quiet
  // reconcile or alter the summary the caller reports.
  if (summary.bound > 0) {
    try {
      deps.onFreshBind?.(conversationId);
    } catch {
      /* notification is a hint, never a verdict — the summary already says it */
    }
  }

  // One bounded, content-free line per run — a refused bind must be VISIBLE
  // (the R2 orphan was invisible), but the log never carries handles or paths.
  if (summary.refused.length > 0) {
    const reasons = summary.refused.map((entry) => `${entry.toolCallId}:${entry.reason}`).join(', ');
    deps.log(
      `[image-artifact-reconcile] ${conversationId}: candidates=${summary.candidates} bound=${summary.bound} alreadyBound=${summary.alreadyBound} refused=${summary.refused.length} (${reasons})`
    );
  }
  return summary;
}
