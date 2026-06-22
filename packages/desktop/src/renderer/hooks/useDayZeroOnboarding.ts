/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Day-0 client-input onboarding hook (Lane 3, spec §3).
 *
 * Decides — at most ONCE, on first run — whether to FORCE the one-client-input
 * prompt that seeds the Company-Brain (the early switching-cost). The decision
 * is the PURE `creditsCore.shouldForceDayZeroOnboarding` over a persisted
 * `commandEve.clientSeeded` flag, so it never re-nags after a real seed.
 *
 * NON-NAGGING (fix #4): the forced modal shows at most once. Both a real seed
 * AND a "Later"/dismiss are STICKY — `dismiss()` persists
 * `commandEve.clientSeedDismissed`, so the modal never re-pops on a later
 * launch. The user can always seed afterwards from Settings → Company Brain
 * (which renders the same UI with `enabled: false` so it never force-pops there).
 *
 * On seed it flips the persisted flag and forwards the seed to the caller-
 * provided sink (the Company-Brain memory write is Hermes/backend scope — this
 * hook records the local switching-cost flag + the seed payload, and exposes a
 * single seam for wiring the real memory write without changing the UI flow).
 */

import { useCallback, useEffect, useState } from 'react';
import { configService } from '@/common/config/configService';
import {
  isClientSeedSatisfied,
  shouldForceDayZeroOnboarding,
  type ClientSeedInput,
} from '@/common/config/creditsCore';

export interface DayZeroOnboardingState {
  /** Whether the force-onboarding prompt should be shown right now. */
  shouldForce: boolean;
  /** True iff the Company-Brain has a real seed recorded (persisted flag). */
  seeded: boolean;
  /** True iff the forced modal was dismissed without seeding (sticky). */
  dismissed: boolean;
  /** Record a real client seed: flips the persisted flag and forwards the seed. */
  recordSeed: (seed: ClientSeedInput) => Promise<void>;
  /** Dismiss without seeding — STICKY (persisted), so the modal never re-pops. */
  dismiss: () => void;
}

export interface UseDayZeroOnboardingArgs {
  /**
   * Only force onboarding once the user is past the entitlement gate (entitled)
   * AND in the force-host context. The Settings → Company Brain panel passes
   * `enabled: false` so it renders the seed UI WITHOUT ever force-popping.
   */
  enabled: boolean;
  /**
   * Sink for the seed — the place that actually writes it into the Company-Brain
   * (Hermes/backend, OUT OF SCOPE here). Defaults to a no-op so the local
   * switching-cost flag is still recorded even before the memory write is wired.
   */
  onSeedRecorded?: (seed: ClientSeedInput) => Promise<void> | void;
}

export function useDayZeroOnboarding(args: UseDayZeroOnboardingArgs): DayZeroOnboardingState {
  const [alreadySeeded, setAlreadySeeded] = useState<boolean>(() => Boolean(configService.get('commandEve.clientSeeded')));
  const [dismissed, setDismissed] = useState<boolean>(() => Boolean(configService.get('commandEve.clientSeedDismissed')));

  // Keep the local flags in sync with config (config initializes async at boot).
  useEffect(() => {
    void configService.whenReady().then(() => {
      setAlreadySeeded(Boolean(configService.get('commandEve.clientSeeded')));
      setDismissed(Boolean(configService.get('commandEve.clientSeedDismissed')));
    });
  }, []);

  const shouldForce =
    args.enabled &&
    // STICKY: once dismissed (or seeded) the forced modal never re-pops.
    !dismissed &&
    // No prior seed object yet at decision time; the gate is purely flag-driven.
    shouldForceDayZeroOnboarding({ alreadySeeded, seed: null });

  const recordSeed = useCallback(
    async (seed: ClientSeedInput) => {
      if (!isClientSeedSatisfied(seed)) return;
      // Forward to the Company-Brain sink first (best-effort), then persist the
      // local switching-cost flag so the prompt never re-nags.
      try {
        await args.onSeedRecorded?.(seed);
      } catch (error) {
        console.error('Day-0 client seed sink failed:', error);
      }
      await configService.set('commandEve.clientSeeded', true);
      setAlreadySeeded(true);
    },
    [args]
  );

  const dismiss = useCallback(() => {
    // STICKY: persist so the forced modal never re-pops on a later launch.
    setDismissed(true);
    void configService.set('commandEve.clientSeedDismissed', true);
  }, []);

  return { shouldForce, seeded: alreadySeeded, dismissed, recordSeed, dismiss };
}
