/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Custom (user-chosen) display names for project workspaces.
 *
 * A project's resting label is the last segment of its workspace PATH (e.g.
 * "hermes-temp-6969007f"). The founder asked to RENAME a project from the
 * sidebar. We deliberately do NOT rename the on-disk directory — that is a
 * heavy, irreversible filesystem op that would also break every conversation's
 * stored `extra.workspace` path. Instead we persist a label OVERRIDE keyed by
 * the workspace path, exactly mirroring `workspaceHistory.ts` (localStorage,
 * same fail-soft shape). The grouping layer consults this override before
 * falling back to the path-derived name.
 *
 * Clearing the name (empty/blank) removes the override and restores the
 * path-derived default.
 */
const WORKSPACE_CUSTOM_NAME_KEY = 'aionui_workspace_custom_name';

function readAll(): Record<string, string> {
  try {
    const stored = localStorage.getItem(WORKSPACE_CUSTOM_NAME_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Record<string, string>;
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // Ignore parsing errors and fall back to no overrides.
  }
  return {};
}

function writeAll(names: Record<string, string>): void {
  try {
    localStorage.setItem(WORKSPACE_CUSTOM_NAME_KEY, JSON.stringify(names));
  } catch (error) {
    console.error('[WorkspaceName] Failed to persist custom workspace name:', error);
  }
}

/** The user-chosen label for a workspace path, or `undefined` when none is set. */
export const getWorkspaceCustomName = (workspace: string): string | undefined => {
  const name = readAll()[workspace];
  return typeof name === 'string' && name.trim() !== '' ? name : undefined;
};

/**
 * Set (or, with a blank value, clear) the custom label for a workspace path.
 * Returns the trimmed name that was stored, or `undefined` when it was cleared.
 */
export const setWorkspaceCustomName = (workspace: string, name: string): string | undefined => {
  const trimmed = name.trim();
  const names = readAll();
  if (trimmed === '') {
    if (workspace in names) {
      delete names[workspace];
      writeAll(names);
    }
    return undefined;
  }
  names[workspace] = trimmed;
  writeAll(names);
  return trimmed;
};
