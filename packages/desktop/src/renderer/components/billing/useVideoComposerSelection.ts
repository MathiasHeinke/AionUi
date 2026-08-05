/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The video-creation selection state, shared by the conversation composer
 * (AcpSendBox) and the start-chat surface (guid) — MAT-1773 P3 parity: both
 * surfaces run the SAME VideoQualityPill, so they hold the selection through
 * the SAME hook. One source for tier/model/resolution/duration state, the
 * capabilities + catalog fetch, and the coherence rules (1080p implies the
 * 1.5 model; a catalog-only model keeps its exact resolution; an explicit
 * pick always wins over the resting default).
 */

import { useCallback, useEffect, useState } from 'react';
import { ipcBridge } from '@/common';
import {
  DEFAULT_VIDEO_DURATION_SECONDS,
  DEFAULT_VIDEO_TIER_ID,
  legacyVideoModelIdForCatalogId,
  type VideoModelSelection,
  type VideoQualityTier,
  type VideoSeatCapabilities,
} from '@/common/config/videoCostCore';
import {
  DEFAULT_VIDEO_CATALOG_MODEL_ID,
  resolveVideoCatalog,
  type VideoCatalogResolution,
} from '@/common/config/videoCatalogCore';

/** The selection a send carries — resolved, never partial. */
export type VideoDraftSelection = {
  modelId: VideoModelSelection;
  resolution: string | null;
  durationSeconds: number;
};

export type VideoComposerSelection = {
  tierId: VideoQualityTier;
  modelId: VideoModelSelection | undefined;
  resolution: string | null;
  durationSeconds: number;
  capabilities: VideoSeatCapabilities;
  catalog: VideoCatalogResolution;
  handleTierChange: (tierId: VideoQualityTier) => void;
  handleModelChange: (modelId: VideoModelSelection) => void;
  handleResolutionChange: (resolution: string) => void;
  setDurationSeconds: (seconds: number) => void;
  /** The selection a send carries right now (explicit pick or the resting default). */
  currentSelection: () => VideoDraftSelection;
  /** Adopt a carried selection (e.g. the guid handoff) so the pill shows it. */
  applySelection: (selection: VideoDraftSelection) => void;
  /** Reset to the resting default after a successful generation. */
  resetSelection: () => void;
};

export function useVideoComposerSelection(): VideoComposerSelection {
  const [tierId, setTierId] = useState<VideoQualityTier>(DEFAULT_VIDEO_TIER_ID);
  const [modelId, setModelId] = useState<VideoModelSelection | undefined>(undefined);
  const [durationSeconds, setDurationSeconds] = useState(DEFAULT_VIDEO_DURATION_SECONDS);
  // The exact catalog resolution (e.g. `720p`, `2K`). Null follows the tier;
  // the pill reports auto-picks upward through this state, so the send
  // carries exactly the combination the pill quoted.
  const [resolution, setResolution] = useState<string | null>(null);
  // The catalog the model dropdown shows. Starts on the bundled snapshot
  // (approximate) and upgrades to the live server catalog the moment the
  // capabilities answer carries one; a failed read simply keeps this.
  const [catalog, setCatalog] = useState<VideoCatalogResolution>(() => resolveVideoCatalog(null));
  // What the SEAT may offer, answered by MAIN (never decided in the renderer);
  // an absent or failed answer stays fail-closed (both flags false).
  const [capabilities, setCapabilities] = useState<VideoSeatCapabilities>({
    hd15Available: false,
    presetVoicesAvailable: false,
  });

  useEffect(() => {
    let cancelled = false;
    void ipcBridge.commandEve.videoCapabilities
      .invoke()
      .then((response) => {
        if (cancelled || !response?.success || !response.data) return;
        setCapabilities({
          hd15Available: response.data.hd15Available === true,
          presetVoicesAvailable: response.data.presetVoicesAvailable === true,
        });
        // The live catalog replaces the bundled snapshot only when Main proves
        // one; anything else keeps the fallback (marked approximate).
        setCatalog(
          resolveVideoCatalog(response.data.catalog_source === 'live' ? (response.data.catalog ?? null) : null)
        );
      })
      .catch(() => {
        /* fail closed: the initial all-false state stands */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleTierChange = useCallback((nextTierId: VideoQualityTier) => {
    setTierId(nextTierId);
    // 1080p is a truthful shorthand for the 1.5 model; keep the two visible
    // selectors coherent instead of letting one invalidate the other.
    if (nextTierId === 'hd') setModelId('grok-imagine-video-1.5');
  }, []);

  const handleModelChange = useCallback((nextModelId: VideoModelSelection) => {
    setModelId(nextModelId);
    if (legacyVideoModelIdForCatalogId(nextModelId) === 'grok-imagine-video') {
      setTierId((current) => (current === 'hd' ? DEFAULT_VIDEO_TIER_ID : current));
    }
  }, []);

  // A resolution pick from the catalog dropdown. It updates the tier
  // shadow-state ONLY (the wire still carries a tier for the legacy lane) and
  // NEVER touches the model: the old hd→1.5 coupling must not hijack a 1080p
  // pick on FLUX/Veo/Sora into a Grok render.
  const handleResolutionChange = useCallback((nextResolution: string) => {
    setResolution(nextResolution);
    const tier =
      nextResolution === '480p'
        ? 'sd'
        : nextResolution === '720p'
          ? 'fast'
          : nextResolution === '1080p'
            ? 'hd'
            : undefined;
    if (tier !== undefined) setTierId(tier);
  }, []);

  const currentSelection = useCallback((): VideoDraftSelection => {
    return {
      modelId: modelId ?? DEFAULT_VIDEO_CATALOG_MODEL_ID,
      resolution,
      durationSeconds,
    };
  }, [modelId, resolution, durationSeconds]);

  const applySelection = useCallback((selection: VideoDraftSelection) => {
    setModelId(selection.modelId);
    setResolution(selection.resolution);
    setDurationSeconds(selection.durationSeconds);
    const tier =
      selection.resolution === '480p'
        ? 'sd'
        : selection.resolution === '720p'
          ? 'fast'
          : selection.resolution === '1080p'
            ? 'hd'
            : undefined;
    if (tier !== undefined) setTierId(tier);
  }, []);

  const resetSelection = useCallback(() => {
    setTierId(DEFAULT_VIDEO_TIER_ID);
    setModelId(undefined);
    setResolution(null);
    setDurationSeconds(DEFAULT_VIDEO_DURATION_SECONDS);
  }, []);

  return {
    tierId,
    modelId,
    resolution,
    durationSeconds,
    capabilities,
    catalog,
    handleTierChange,
    handleModelChange,
    handleResolutionChange,
    setDurationSeconds,
    currentSelection,
    applySelection,
    resetSelection,
  };
}
