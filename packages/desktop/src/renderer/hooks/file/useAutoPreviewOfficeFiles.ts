/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { ConversationContextValue } from '@/renderer/hooks/context/ConversationContext';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { useAutoPreviewOfficeFilesEnabled } from '@/renderer/hooks/system/useAutoPreviewOfficeFilesEnabled';
import { getFileTypeInfo } from '@/renderer/utils/file/fileType';
import { useCallback, useEffect, useRef } from 'react';

const OFFICE_OPEN_DELAY_MS = 1000;
// 'html' is included for the Guided Onboarding S3 step-screen bonus only. The proven
// PRIMARY path for an EVE-authored onboarding.html is the click chain (FileChangesPanel
// -> launchPreview -> HTMLRenderer), which needs no change here.
//
// CORRECTED 2026-08-07 — this used to say auto-open "is inert in this worktree (no
// backend watcher emits fileAdded)". That is false: the sender exists and both ends
// are wired. Measured against the pinned binary
// _aioncore-pinned/darwin-arm64/aioncore, sha256
// 5c76f01f8d8ed1895abed27963a254dda1557384a681e600ce9f65272ac50d00:
//
//   - `strings` finds `workspaceOfficeWatch.fileAdded` sitting directly beside
//     `crates/aionui-file/src/watch_service.rs:98` and the literals
//     `create` / `change` / `remove` — that Rust watcher IS the emitter.
//   - The routes `/api/fs/office-watch/start` and `/api/fs/office-watch/stop` are
//     both in the binary's route table.
//   - This hook calls both (`:158` start, `:191` stop) and subscribes at `:174`;
//     MessageList.tsx:299 mounts it.
//
// WHAT IS STILL UNPROVEN, and the reason this note does not claim it works: nobody
// has watched an event arrive. `strings` proves the symbols are compiled in, not
// that the watcher fires, matches, and reaches this listener at runtime. That is a
// live test on a packaged app, not something the source can settle. So: wired end
// to end, live behaviour unverified.
//
// One caveat the strings cannot resolve either: the literal `docx / pptx / xlsx`
// is present in the binary, but `strings` cannot show which code path filters on
// it, so the extension set is evidence, not proof.
const OFFICE_CONTENT_TYPES = new Set(['ppt', 'word', 'excel', 'html']);

// Marker-gate for the html auto-open bonus: only auto-open HTML files that follow the
// generated step-screen naming convention (onboarding.html / onboarding-<step>.html).
// This keeps arbitrary user/agent HTML from being auto-surfaced — those still open via
// the explicit preview-click chain. Gating on the filename keeps this hook synchronous
// and side-effect-free (no file read). Marker constant lives next to the template in
// runtimeBootstrapCore (COMMAND_EVE_ONBOARDING_STEP_MARKER) for the in-content marker;
// here we gate on the filename so no async read is needed in the watch path.
const ONBOARDING_STEP_FILE_RE = /(^|[\\/])onboarding(?:-[a-z0-9-]+)?\.html$/i;

// Exported (additive, pure) so the S3 marker-gate is unit-testable without mounting
// the DOM hook. The hook's behaviour is unchanged; this is only the eligibility predicate.
export const isAutoOpenEligible = (file_path: string, contentType: string): boolean => {
  if (contentType !== 'html') return OFFICE_CONTENT_TYPES.has(contentType);
  // html: bonus auto-open ONLY for generated onboarding step-screens.
  return ONBOARDING_STEP_FILE_RE.test(file_path);
};

const normalizeWatchPath = (value: string): string => {
  const normalized = value.replaceAll('\\', '/');

  if (normalized === '/private/var') return '/var';
  if (normalized.startsWith('/private/var/')) return normalized.slice('/private'.length);
  if (normalized === '/private/tmp') return '/tmp';
  if (normalized.startsWith('/private/tmp/')) return normalized.slice('/private'.length);

  return normalized;
};

/**
 * Fold the workspace baseline INTO whatever the live watcher already recorded.
 *
 * THE RACE THIS CLOSES. The baseline is built asynchronously (start the watcher,
 * then list the workspace), while the `fileAdded` subscription is live from the
 * moment the effect runs. A file dropped in that window opens correctly and is
 * recorded — and the baseline then REPLACED the whole set with `new Set(...)`,
 * dropping that record. A second event for the same file found an empty memory
 * and opened it again.
 *
 * Union, not replace, so nothing recorded in the gap is lost. The baseline is
 * still filtered by the same eligibility predicate the live path uses, so this
 * cannot smuggle an ineligible path in through the back door.
 *
 * Pure, and exported additively like its two neighbours: the merge is the whole
 * behaviour, so it is where the test belongs.
 */
export const mergeWorkspaceBaseline = (
  alreadyKnown: ReadonlySet<string>,
  workspaceFilePaths: readonly string[]
): Set<string> => {
  const merged = new Set(alreadyKnown);
  for (const raw of workspaceFilePaths) {
    const normalized = normalizeWatchPath(raw);
    if (isAutoOpenEligible(normalized, getFileTypeInfo(normalized).contentType)) merged.add(normalized);
  }
  return merged;
};

/**
 * The whole decision for ONE incoming `fileAdded` event, in the order that
 * matters: is it my workspace, may it be auto-opened at all, and have I seen it
 * already? Returns the normalized path to open, or null.
 *
 * WHAT THE ELIGIBILITY CHECK BEING HERE FIXES. It used to be missing from this
 * path entirely — it ran only when the baseline was built — so every event
 * opened whatever the backend reported and the marker gate never applied to a
 * single live file. That is the defect this function closed.
 *
 * ELIGIBILITY BEFORE DEDUPE is intentional, and it is NOT observable from
 * outside. Measured, not assumed: swap the two guards and every return value is
 * unchanged. Both answer `null`; `getFileTypeInfo` is total (fileType.ts:59-62 —
 * a map lookup with a fallback, no throw path), so not even an exception can
 * order them; and the `fileAdded` handler below records ONLY a non-null return,
 * so an ineligible path cannot enter the known set under either order. Every
 * suite covering this stays green with the lines swapped.
 *
 * An earlier version of this comment claimed the reverse order would leave a
 * hole — an ineligible path recorded as "known", a later eligible event for it
 * swallowed as a repeat. It cannot happen, for the reason above, and ade6d6a2's
 * own message already said the ordering was unobservable while this comment
 * asserted the opposite. Two claims from one commit, one of them wrong; this is
 * the wrong one. The order states what the function MEANS, and that is all it
 * is — which is why the test block is named after the property that does hold
 * (nothing ineligible reaches the set), not after the ordering.
 *
 * Exported additively — like {@link isAutoOpenEligible} — so the decision is
 * testable without mounting the hook. The hook's own signature is unchanged.
 */
export const decideWatchedFileOpen = (
  event: { file_path: string; workspace: string },
  normalizedWorkspace: string,
  known: ReadonlySet<string>
): string | null => {
  if (normalizeWatchPath(event.workspace) !== normalizedWorkspace) return null;
  const normalizedFilePath = normalizeWatchPath(event.file_path);
  if (!isAutoOpenEligible(normalizedFilePath, getFileTypeInfo(normalizedFilePath).contentType)) return null;
  if (known.has(normalizedFilePath)) return null;
  return normalizedFilePath;
};

/**
 * Auto-opens a preview tab when a new .pptx/.docx/.xlsx file appears in the
 * workspace during the current conversation.
 *
 * The backend keeps a workspace watcher and emits `workspaceOfficeWatch.fileAdded`
 * when a matching file is created. This hook captures the initial baseline once,
 * then opens previews only for newly added Office files.
 */
export const useAutoPreviewOfficeFiles = (
  conversation: Pick<ConversationContextValue, 'conversation_id' | 'workspace'> | null
) => {
  const enabled = useAutoPreviewOfficeFilesEnabled();
  const { findPreviewTab, openPreview } = usePreviewContext();
  const knownOfficeFilesRef = useRef<Set<string>>(new Set());
  const openTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const workspace = conversation?.workspace?.trim() ? conversation.workspace : undefined;
  const normalizedWorkspace = workspace ? normalizeWatchPath(workspace) : undefined;

  const clearPendingOpenTimers = useCallback(() => {
    for (const timer of openTimersRef.current.values()) {
      clearTimeout(timer);
    }
    openTimersRef.current.clear();
  }, []);

  const openOfficePreview = useCallback(
    (file_path: string) => {
      if (!workspace) return;
      const normalizedFilePath = normalizeWatchPath(file_path);
      if (openTimersRef.current.has(normalizedFilePath)) return;

      const { contentType } = getFileTypeInfo(file_path);
      if (!isAutoOpenEligible(file_path, contentType)) return;

      const file_name = file_path.split(/[\\/]/).pop() ?? file_path;
      const timer = setTimeout(() => {
        openTimersRef.current.delete(normalizedFilePath);

        if (!findPreviewTab(contentType, '', { file_path, file_name })) {
          openPreview('', contentType, { file_path, file_name, title: file_name, workspace, editable: false });
        }
      }, OFFICE_OPEN_DELAY_MS);

      openTimersRef.current.set(normalizedFilePath, timer);
    },
    [findPreviewTab, openPreview, workspace]
  );

  useEffect(() => {
    knownOfficeFilesRef.current = new Set();
    clearPendingOpenTimers();

    // `normalizedWorkspace` is derived from `workspace` and is therefore set at
    // exactly the same times. Naming it in the guard costs one condition and lets
    // the compiler see the pairing, which is cheaper than deriving it a second
    // time inside the effect and cannot drift from the value in the dep array.
    if (!enabled || !workspace || !normalizedWorkspace) {
      return;
    }

    let cancelled = false;
    const primeOfficeWatch = async () => {
      try {
        await ipcBridge.workspaceOfficeWatch.start.invoke({ workspace });
        const currentFiles = await ipcBridge.fs.listWorkspaceFiles.invoke({ root: workspace });
        if (cancelled) return;
        // UNION, never replace: a file that arrived while the two awaits above
        // were in flight is already recorded, and overwriting the set would make
        // the next event for it look new. `cancelled` still guards the write, so
        // a torn-down effect never touches the ref; and the effect head resets it
        // to an empty set, so a re-run starts clean and no path crosses between
        // conversations.
        knownOfficeFilesRef.current = mergeWorkspaceBaseline(
          knownOfficeFilesRef.current,
          currentFiles.map((file) => file.fullPath)
        );
      } catch {
        // Ignore watcher/bootstrap failures; the hook should stay inert rather than noisy.
      }
    };

    void primeOfficeWatch();

    const unsubscribeFileAdded = ipcBridge.workspaceOfficeWatch.fileAdded.on((event) => {
      try {
        const normalizedFilePath = decideWatchedFileOpen(event, normalizedWorkspace, knownOfficeFilesRef.current);
        if (normalizedFilePath === null) return;

        knownOfficeFilesRef.current.add(normalizedFilePath);
        openOfficePreview(event.file_path);
      } catch (error) {
        console.error('[useAutoPreviewOfficeFiles] failed to process fileAdded event', error, event);
      }
    });

    return () => {
      cancelled = true;
      unsubscribeFileAdded();
      clearPendingOpenTimers();
      knownOfficeFilesRef.current.clear();
      void ipcBridge.workspaceOfficeWatch.stop.invoke({ workspace }).catch(() => {});
    };
  }, [clearPendingOpenTimers, enabled, normalizedWorkspace, openOfficePreview, workspace]);
};
