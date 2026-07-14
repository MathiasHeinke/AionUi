/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AutoUpdateStatus } from './updateTypes';

const ACTIVE_UPDATE_STATES = new Set<AutoUpdateStatus['status']>(['available', 'downloading', 'downloaded']);

const cloneStatus = (status: AutoUpdateStatus): AutoUpdateStatus => ({
  ...status,
  progress: status.progress ? { ...status.progress } : undefined,
});

/**
 * Keep durable update metadata while electron-updater emits progress-only
 * events. A downloaded package remains installable during later background
 * checks, and a newer available version supersedes the deferred package.
 */
export function mergeAutoUpdateStatus(previous: AutoUpdateStatus | null, incoming: AutoUpdateStatus): AutoUpdateStatus {
  if (!previous) return cloneStatus(incoming);

  if (ACTIVE_UPDATE_STATES.has(previous.status) && incoming.status === 'checking') {
    return cloneStatus(previous);
  }

  if (previous.status === 'downloaded') {
    if (incoming.status === 'not-available' || incoming.status === 'error' || incoming.status === 'cancelled') {
      return cloneStatus(previous);
    }
    if (incoming.status === 'available' && incoming.version === previous.version) {
      return cloneStatus(previous);
    }
  }

  if (incoming.status === 'available' || incoming.status === 'not-available') {
    return cloneStatus(incoming);
  }

  const merged: AutoUpdateStatus = {
    ...previous,
    ...incoming,
    status: incoming.status,
    version: incoming.version ?? previous.version,
    releaseDate: incoming.releaseDate ?? previous.releaseDate,
    releaseNotes: incoming.releaseNotes ?? previous.releaseNotes,
    error: incoming.error,
  };

  if (incoming.progress) {
    merged.progress = { ...incoming.progress };
  } else if (incoming.status !== 'downloading') {
    merged.progress = undefined;
  }

  return merged;
}
