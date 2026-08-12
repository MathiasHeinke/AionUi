/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Production seat scope and post-await fence for the native Hermes board. */

import { getActiveSeatContextRevision, getActiveSeatId, resolveActiveSeatHome } from './seatContextCore';

export type NativeKanbanSeatScope = {
  userDataPath: string;
  hermesHome: string;
  seatId: string;
  revision: number;
};

export function captureNativeKanbanSeatScope(userDataPath: string): NativeKanbanSeatScope {
  return {
    userDataPath,
    hermesHome: resolveActiveSeatHome(userDataPath).hermesHome,
    seatId: getActiveSeatId(),
    revision: getActiveSeatContextRevision(),
  };
}

export function nativeKanbanSeatScopeStillActive(scope: NativeKanbanSeatScope): boolean {
  return scope.seatId === getActiveSeatId() && scope.revision === getActiveSeatContextRevision();
}
