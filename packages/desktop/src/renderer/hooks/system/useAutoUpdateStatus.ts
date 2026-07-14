/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSyncExternalStore } from 'react';
import { ipcBridge } from '@/common';
import { mergeAutoUpdateStatus } from '@/common/update/autoUpdateState';
import type { AutoUpdateStatus } from '@/common/update/updateTypes';

export type AutoUpdateUiSnapshot = AutoUpdateStatus | { status: 'idle' };

const IDLE_SNAPSHOT: AutoUpdateUiSnapshot = { status: 'idle' };

let snapshot: AutoUpdateUiSnapshot = IDLE_SNAPSHOT;
let bridgeStarted = false;
let eventRevision = 0;
let removeBridgeListener: (() => void) | null = null;
const listeners = new Set<() => void>();

const publish = (incoming: AutoUpdateStatus): void => {
  const previous = snapshot.status === 'idle' ? null : snapshot;
  snapshot = mergeAutoUpdateStatus(previous, incoming);
  for (const listener of listeners) listener();
};

const startBridge = (): void => {
  if (bridgeStarted) return;
  bridgeStarted = true;

  removeBridgeListener = ipcBridge.autoUpdate.status.on((status) => {
    if (!status) return;
    eventRevision += 1;
    publish(status);
  });

  const revisionAtHydration = eventRevision;
  void ipcBridge.autoUpdate.getStatus
    .invoke()
    .then((response) => {
      const durableStatus = response?.success ? response.data?.status : null;
      if (!durableStatus) return;

      if (eventRevision !== revisionAtHydration && snapshot.status !== 'idle') {
        // A progress event can beat the IPC response while carrying no version
        // or release notes. Keep the live phase/progress, but hydrate its durable
        // metadata from the main-process snapshot.
        publish(mergeAutoUpdateStatus(durableStatus, snapshot));
        return;
      }

      publish(durableStatus);
    })
    .catch((error) => {
      console.warn('Failed to hydrate auto-update status:', error);
    });
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  startBridge();
  return () => listeners.delete(listener);
};

export const getAutoUpdateStatusSnapshot = (): AutoUpdateUiSnapshot => snapshot;

export function useAutoUpdateStatus(): AutoUpdateUiSnapshot {
  return useSyncExternalStore(subscribe, getAutoUpdateStatusSnapshot, getAutoUpdateStatusSnapshot);
}

export function resetAutoUpdateStatusStoreForTest(): void {
  removeBridgeListener?.();
  removeBridgeListener = null;
  bridgeStarted = false;
  eventRevision = 0;
  snapshot = IDLE_SNAPSHOT;
  listeners.clear();
}
