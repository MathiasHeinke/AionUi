/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import {
  DEFAULT_COMMAND_EVE_IMAGE_MODEL_TIER,
  type CommandEveImageModelRegistry,
  type CommandEveImageModelResolution,
  type CommandEveImageModelTierId,
} from '@/common/config/eveImageModelRegistryCore';
import type { CommandEveManagedImageAspectRatio } from '@/common/config/eveManagedImageGenerationCore';
import { useCallback, useEffect, useRef, useState } from 'react';

export type ImageComposerSelection = Readonly<{
  tierId: CommandEveImageModelTierId;
  registry: CommandEveImageModelRegistry | null;
  resolution: CommandEveImageModelResolution;
  aspectRatio: CommandEveManagedImageAspectRatio;
  /**
   * Updates the durable create preference unless the caller is carrying a
   * request-scoped edit selection in its composer state.
   */
  setTierId: (tierId: CommandEveImageModelTierId, options?: Readonly<{ persist?: boolean }>) => void;
  setResolution: (resolution: CommandEveImageModelResolution) => void;
  setAspectRatio: (aspectRatio: CommandEveManagedImageAspectRatio) => void;
}>;

/** Main-authoritative per-seat image preference, shared by both composers. */
export function useImageComposerSelection(): ImageComposerSelection {
  const [tierId, setTierIdState] = useState<CommandEveImageModelTierId>(DEFAULT_COMMAND_EVE_IMAGE_MODEL_TIER);
  const [registry, setRegistry] = useState<CommandEveImageModelRegistry | null>(null);
  const [resolution, setResolution] = useState<CommandEveImageModelResolution>('1K');
  const [aspectRatio, setAspectRatio] = useState<CommandEveManagedImageAspectRatio>('16:9');
  const preferenceSeatRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void ipcBridge.commandEve.imageModelPreferenceRead
      .invoke()
      .then((response) => {
        if (cancelled || !response?.success || !response.data || response.data.status !== 'resolved') return;
        preferenceSeatRef.current = response.data.seatId;
        setTierIdState(response.data.tier);
      })
      .catch((): void => undefined);
    void ipcBridge.commandEve.imageCapabilities
      .invoke()
      .then((response) => {
        if (!cancelled && response?.success && response.data?.ok) setRegistry(response.data.registry);
      })
      .catch((): void => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const setTierId = useCallback((nextTierId: CommandEveImageModelTierId, options?: Readonly<{ persist?: boolean }>) => {
    // An image edit keeps its model on the explicit one-shot composer request.
    // Do not mutate the shared create state or write the per-seat preference:
    // leaving edit must still reveal the exact create tier Main will bill.
    if (options?.persist === false) return;
    setTierIdState(nextTierId);
    const expectedSeatId = preferenceSeatRef.current;
    if (!expectedSeatId) return;

    const reconcile = () => {
      void ipcBridge.commandEve.imageModelPreferenceRead
        .invoke()
        .then((response) => {
          if (response?.success && response.data?.status === 'resolved') {
            preferenceSeatRef.current = response.data.seatId;
            setTierIdState(response.data.tier);
          }
        })
        .catch((): void => undefined);
    };
    void ipcBridge.commandEve.imageModelPreferenceSet
      .invoke({ expectedSeatId, tier: nextTierId })
      .then((response) => {
        if (response?.success && response.data?.ok && response.data.preference.status === 'resolved') {
          setTierIdState(response.data.preference.tier);
          return;
        }
        reconcile();
      })
      .catch(reconcile);
  }, []);

  return { tierId, registry, resolution, aspectRatio, setTierId, setResolution, setAspectRatio };
}
