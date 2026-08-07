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
// 83a4e7432f280995c9681bab559684f8ad747270b3f5c6b6c2f28c94bc2d3a8a:
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
 * The whole decision for ONE incoming `fileAdded` event, in the order that
 * matters: is it my workspace, may it be auto-opened at all, and have I seen it
 * already? Returns the normalized path to open, or null.
 *
 * ELIGIBILITY BEFORE DEDUPE, and that order is the point. The check used to be
 * missing here entirely (it ran only when the baseline was built), so every
 * event opened whatever the backend reported and the marker gate below never
 * applied to a live file. Putting it AFTER the dedupe would fix the opening and
 * still leave a hole: an ineligible path would be recorded as "known", and a
 * later, eligible event for that same path would be swallowed as a repeat.
 *
 * Exported additively — like {@link isAutoOpenEligible} — so the ordering is
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

    if (!enabled || !workspace) {
      return;
    }

    let cancelled = false;
    const primeOfficeWatch = async () => {
      try {
        await ipcBridge.workspaceOfficeWatch.start.invoke({ workspace });
        const currentFiles = await ipcBridge.fs.listWorkspaceFiles.invoke({ root: workspace });
        if (cancelled) return;
        knownOfficeFilesRef.current = new Set(
          currentFiles
            .map((file) => file.fullPath)
            .map((file_path) => normalizeWatchPath(file_path))
            .filter((file_path) => isAutoOpenEligible(file_path, getFileTypeInfo(file_path).contentType))
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
