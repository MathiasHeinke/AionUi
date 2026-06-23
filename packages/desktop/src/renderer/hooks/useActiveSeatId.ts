/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * useActiveSeatId (Phase 4 / A5) — the single reactive renderer signal for "which
 * seat are we on right now". It returns configService's CURRENT bound seat id and
 * re-renders whenever a seat switch re-homes the config cache (rebindSeat).
 *
 * WHY configService and not useSeatAccess: configService.currentSeatId is THE
 * renderer's authoritative seat binding. The switch lifecycle (useSeatAccess.
 * switchTo, STEP-2b) rebinds it to the seat the MAIN process reports it ended up
 * on — the target on success, the prior seat on a rollback — so this id is always
 * the real, post-switch active seat, never an un-confirmed guess.
 *
 * THE CLASS THIS CLOSES: any renderer hook that seeds seat-scoped state in a
 * MOUNT-ONCE useState/useEffect([]) and does not subscribe to configService will
 * survive a switch and keep serving the prior seat's value (e.g. the Day-0
 * onboarding `alreadySeeded` / `dismissed`). Keying a per-seat HOST by this id at
 * its mount site REMOUNTS the whole subtree on a switch, so every mount-once seat
 * read re-fires under the new seat — without per-field patches in each hook.
 *
 * LEGACY-SAFE: on a single-seat / legacy install no switch ever happens, so
 * rebindSeat never fires the seat-rebind signal (it early-returns on a no-op) and
 * this hook returns a STABLE id — the key never changes, no extra remount, no
 * extra read. Byte-identical to 1.1.3 behavior.
 */

import { useEffect, useState } from 'react';
import { configService } from '@/common/config/configService';

export function useActiveSeatId(): string {
  const [seatId, setSeatId] = useState<string>(() => configService.getCurrentSeatId());

  useEffect(() => {
    // Re-sync once on mount in case the binding moved between the initial render
    // and the effect (e.g. configService.initialize resolved the active seat).
    setSeatId(configService.getCurrentSeatId());
    const unsubscribe = configService.onSeatRebind((next) => setSeatId(next));
    return unsubscribe;
  }, []);

  return seatId;
}
