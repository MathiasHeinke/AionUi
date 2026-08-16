/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inline video-quality selector — a PICKER, never a gate.
 *
 * 1080p used to be reachable only from inside the pre-submit cost wall. Removing
 * that wall (asking for a video is the authorisation to make one) also removed
 * the only surface that could select HD, which left the tier silently
 * unreachable. This is the replacement, and it is deliberately NOT a modal:
 *
 *   - it never blocks the send, and it has no confirm/cancel,
 *   - it appears only while the draft actually routes to the video lane, so it
 *     is not permanent furniture in the composer,
 *   - it starts on Fast/720p; HD is reached only by a click, which is what keeps
 *     `isExplicitUpgrade` an honest statement rather than an assumption.
 *
 * The credit figure is shown for the SELECTED tier so the price is legible at the
 * moment of choosing. It informs; it does not ask. The only thing that may refuse
 * a video is the server-side pre-flight reservation (`reservePaidLane` →
 * `canAfford`, 402 on `insufficient_credits` / `spend_cap_exceeded`).
 *
 * MAT-1773 (F8b): with a catalog present, model, RESOLUTION and DURATION are
 * all dropdowns in the same in-place idiom, and the resolution/duration
 * options come from the SELECTED model's catalog entry — an unsupported
 * combination is UNSELECTABLE (filtered out), and a selection the new model
 * cannot serve is auto-picked to the nearest supported value and reported
 * upward, never a late error.
 *
 * MAT-1773 (P1/P2, 1.820.5): the dropdowns portal to `document.body` (the
 * composer panel is `overflow: hidden` — an in-flow list is CLIPPED by the
 * composer edge), open upward when there is no room below, and cap their
 * height with internal scroll. Rows carry provider identity chips, the list is
 * sectioned ('Empfohlen' curated, 'Alle Modelle' price-ascending, curated ids
 * never duplicated), and selection shows a clear check with a warm accent.
 *
 * MAT-1773 (PACKAGE A): the dropdown shell and the sectioned model list are
 * the SHARED `MediaModelDropdown`/`MediaPillDropdown` — the image model pill
 * renders through the same components. Only the catalog→row mapping and the
 * resolution/duration option lists stay pill-specific here.
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckSmall } from '@renderer/components/icons';
import {
  DEFAULT_VIDEO_DURATION_SECONDS,
  estimateVideoCost,
  getVideoTier,
  legacyVideoModelIdForCatalogId,
  listAvailableVideoModels,
  listAvailableVideoTiers,
  MAX_VIDEO_REFERENCE_AUDIOS,
  videoCatalogUsdPerSecond,
  type VideoModeKind,
  type VideoModelSelection,
  type VideoPresetVoice,
  type VideoQualityTier,
  type VideoSeatCapabilities,
} from '@/common/config/videoCostCore';
import {
  DEFAULT_VIDEO_CATALOG_MODEL_ID,
  displayVideoCatalogName,
  estimateVideoCatalogCredits,
  formatVideoCatalogPrice,
  listVideoCatalogBeyondTopFive,
  resolveVideoCatalogSelection,
  resolveVideoCatalogTopFive,
  videoCatalogProvider,
  type VideoCatalogEntry,
} from '@/common/config/videoCatalogCore';
import {
  MediaModelDropdown,
  MediaPillDropdown,
  type MediaModelRow,
} from '@/renderer/components/billing/MediaModelDropdown';
import './billing.css';

export interface VideoQualityPillProps {
  /** The currently selected tier. */
  value: VideoQualityTier;
  /** Select a tier. Called on click only — never automatically. */
  onChange: (tierId: VideoQualityTier) => void;
  /** Explicit contextual model selection. Absent retains automatic routing. */
  modelId?: VideoModelSelection;
  onModelChange?: (modelId: VideoModelSelection) => void;
  /**
   * F8b — the selected catalog resolution (e.g. `720p`, `2K`). Absent follows
   * the tier. Only consulted in catalog mode; legacy mode uses `value`.
   */
  resolution?: string | null;
  onResolutionChange?: (resolution: string) => void;
  /** Clip duration in seconds, for the credit estimate (defaults to the core's). */
  durationSeconds?: number;
  onDurationChange?: (durationSeconds: number) => void;
  /** Hide the control entirely (the draft does not route to video). */
  visible: boolean;
  /**
   * Which of the four mutually exclusive modes this send will use. Not cosmetic:
   * the mode picks the MODEL, and the model is half of the price. A reference
   * render runs on 1.5 at double the base 720p rate, so a pill that did not know
   * the mode would quote the wrong number with total confidence.
   */
  modeKind: VideoModeKind;
  /**
   * What the SEAT may reach, as answered by Main. Absent means "nothing proven",
   * which is the fail-closed reading: no 1080p, no reference mode, no voices.
   */
  capabilities?: VideoSeatCapabilities;
  /**
   * MAT-1773 (F8) — the video catalog the model dropdown lists (live from the
   * capabilities endpoint, or the bundled snapshot when that read failed).
   * Absent keeps the legacy two-model radio (back-compat for other consumers).
   */
  catalogEntries?: readonly VideoCatalogEntry[];
  /** True when the entries are the fallback snapshot — prices shown as approximate. */
  catalogApproximate?: boolean;
  /** The preset voices this seat may pick from. Rendered only when entitled. */
  presetVoices?: readonly VideoPresetVoice[];
  /** The currently selected preset voice ids (at most MAX_VIDEO_REFERENCE_AUDIOS). */
  selectedVoiceIds?: readonly string[];
  onVoiceToggle?: (voiceId: string) => void;
}

/** The legacy tier a resolution maps to, when it names one (2K/4K map to none). */
const tierIdForResolution = (resolution: string): VideoQualityTier | undefined => {
  if (resolution === '480p') return 'sd';
  if (resolution === '720p') return 'fast';
  if (resolution === '1080p') return 'hd';
  return undefined;
};

type DropdownKind = 'model' | 'resolution' | 'duration';

const VideoQualityPill: React.FC<VideoQualityPillProps> = ({
  value,
  onChange,
  modelId,
  onModelChange,
  resolution,
  onResolutionChange,
  durationSeconds,
  onDurationChange,
  visible,
  modeKind,
  capabilities,
  catalogEntries,
  catalogApproximate = false,
  presetVoices,
  selectedVoiceIds,
  onVoiceToggle,
}) => {
  const { t } = useTranslation();
  // One open dropdown at a time; 'Weitere anzeigen' expands the catalog within
  // the SAME list — no page jump, no modal (the show-all state lives in the
  // shared MediaModelDropdown).
  const [openDropdown, setOpenDropdown] = useState<DropdownKind | null>(null);

  const catalog = visible && catalogEntries !== undefined && catalogEntries.length > 0 ? catalogEntries : undefined;
  const models = listAvailableVideoModels({
    modeKind,
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(catalog === undefined ? {} : { catalog }),
  });
  const modelAvailable = (candidate: VideoModelSelection): boolean => {
    const normalized = legacyVideoModelIdForCatalogId(candidate) ?? candidate;
    return models.includes(candidate) || models.includes(normalized);
  };
  // With a catalog the RESTING state is a real selection: Grok Imagine Video
  // 1.5 stays the default. An explicit pick always wins; a selection the seat
  // cannot produce falls through to the economical automatic route.
  const requestedModelId = modelId ?? (catalog ? DEFAULT_VIDEO_CATALOG_MODEL_ID : undefined);
  const effectiveModelId =
    requestedModelId !== undefined && modelAvailable(requestedModelId) ? requestedModelId : undefined;
  const currentCatalogEntry = catalog?.find(
    (entry) => entry.id === effectiveModelId || legacyVideoModelIdForCatalogId(entry.id) === effectiveModelId
  );
  const isCatalogOnlyModel =
    currentCatalogEntry !== undefined && legacyVideoModelIdForCatalogId(currentCatalogEntry.id) === null;

  // F8b — the EFFECTIVE (resolution, duration) for the selected model: the
  // catalog entry's bounds are the only options, and a value the model cannot
  // serve is auto-picked to the NEAREST supported one (flagged, so it is
  // reported upward and shown — never a late error).
  const requestedResolution = resolution ?? getVideoTier(value).resolution;
  const selection = currentCatalogEntry
    ? resolveVideoCatalogSelection({
        entry: currentCatalogEntry,
        resolution: requestedResolution,
        durationSeconds: durationSeconds ?? DEFAULT_VIDEO_DURATION_SECONDS,
      })
    : null;
  const effectiveResolution = selection?.resolution ?? requestedResolution;
  const effectiveDuration = selection?.durationSeconds ?? durationSeconds ?? DEFAULT_VIDEO_DURATION_SECONDS;
  const effectiveTierId = tierIdForResolution(effectiveResolution) ?? value;

  // Report an auto-pick upward so the PARENT's state converges to the
  // supported value — the change the trigger shows is then real state, and
  // the send carries exactly what the pill quotes. Entry change only: picking
  // a new model is what can invalidate the previous combination.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!selection || !currentCatalogEntry) return;
    if (selection.resolutionAdjusted && selection.resolution !== null) {
      onResolutionChange?.(selection.resolution);
      const tier = tierIdForResolution(selection.resolution);
      if (tier !== undefined) onChange(tier);
    }
    if (selection.durationAdjusted && selection.durationSeconds !== null) {
      onDurationChange?.(selection.durationSeconds);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCatalogEntry?.id]);

  if (!visible) return null;

  // Only what this request can ACTUALLY produce for the selected model. A model
  // switch can remove 1080p immediately; an impossible stale tier is represented
  // by the economical default below, never by a price for another request.
  const tiers = listAvailableVideoTiers({
    modeKind,
    ...(effectiveModelId === undefined ? {} : { modelId: effectiveModelId }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(catalog === undefined ? {} : { catalog }),
  });
  if (tiers.length === 0 && !isCatalogOnlyModel) return null;
  const effectiveTier =
    tiers.find((tier) => tier.id === effectiveTierId) ?? tiers.find((tier) => tier.isDefault) ?? tiers[0];

  // ONE resolution of mode + tier + capability, shared with the send path. The
  // pill does not recompute a price of its own — a second derivation is a second
  // answer, and the one the user reads must be the one the request carries. For
  // a catalog-only model the plan prices the EXACT catalog resolution.
  const preview = estimateVideoCost({
    modeKind,
    tierId: effectiveTier?.id ?? 'fast',
    ...(effectiveModelId === undefined ? {} : { modelId: effectiveModelId }),
    durationSeconds: effectiveDuration,
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(catalog === undefined ? {} : { catalog }),
    ...(isCatalogOnlyModel && selection?.resolution != null ? { resolutionOverride: selection.resolution } : {}),
  });
  if (preview === undefined) return null;

  // THE CAPABILITY GATE. Preset voices are US trusted-partner only, so an
  // unentitled seat must not see the control at all — a rendered control is a
  // promise, and refusing after the click is the failure this avoids. Note there
  // is no custom-audio control here and no prop that could carry one: custom
  // uploads are unsupported upstream, so nothing in this component can expose
  // them.
  const voices = presetVoices ?? [];
  const showVoices = modeKind === 'reference' && capabilities?.presetVoicesAvailable === true && voices.length > 0;
  const chosenVoiceIds = selectedVoiceIds ?? [];

  // The catalog halves of the SHARED model dropdown (MediaModelDropdown):
  // the curated shortlist in its fixed order ('Empfohlen'), and everything
  // else sorted by USD/second ascending behind 'Weitere anzeigen'
  // ('Alle Modelle'). The long list NEVER repeats a curated id
  // (normalized-id dedupe in the core).
  const topFive = catalog ? resolveVideoCatalogTopFive(catalog) : [];
  const beyondTopFive = catalog ? listVideoCatalogBeyondTopFive(catalog) : [];

  // One catalog entry -> one generic dropdown row. The row carries its own
  // honest estimate: THIS model's nearest supported resolution and duration
  // for the current request, at the catalog's exact price.
  const toModelRow = (entry: VideoCatalogEntry): MediaModelRow => {
    const provider = videoCatalogProvider(entry);
    const rowSelection = resolveVideoCatalogSelection({
      entry,
      resolution: effectiveResolution,
      durationSeconds: effectiveDuration,
    });
    const rowResolution = rowSelection.resolution;
    const estimate = estimateVideoCatalogCredits({
      entry,
      resolution: rowResolution,
      durationSeconds: rowSelection.durationSeconds ?? effectiveDuration,
    });
    return {
      id: entry.id,
      name: displayVideoCatalogName(entry),
      providerKey: provider.key,
      providerLabel: provider.label,
      priceLabel: formatVideoCatalogPrice(videoCatalogUsdPerSecond(entry, rowResolution)),
      estimateCredits: estimate?.credits,
      disabled: estimate === undefined,
    };
  };

  return (
    <div
      className='video-quality-pill'
      data-testid='video-quality-pill'
      data-selected-tier={effectiveTier?.id ?? value}
      data-mode={modeKind}
      data-model={preview.plan.model}
      data-resolution={preview.plan.resolution}
      data-duration-seconds={preview.plan.durationSeconds}
    >
      {onModelChange && catalog ? (
        <div className='video-quality-pill__group' data-testid='video-model-group'>
          <span className='video-quality-pill__label'>{t('credits.video.modelLabel', { defaultValue: 'Modell' })}</span>
          <MediaModelDropdown
            open={openDropdown === 'model'}
            onToggle={() => setOpenDropdown((open) => (open === 'model' ? null : 'model'))}
            onClose={() => setOpenDropdown(null)}
            ariaLabel={t('credits.video.modelChoose', { defaultValue: 'Modell wählen' })}
            testIdPrefix='video-model'
            triggerActive={modelId !== undefined}
            triggerContent={
              <>
                {currentCatalogEntry ? displayVideoCatalogName(currentCatalogEntry) : preview.plan.model}
                {' · '}
                {formatVideoCatalogPrice(preview.plan.usdPerSecond)}
              </>
            }
            recommended={topFive.map(toModelRow)}
            rest={beyondTopFive.map(toModelRow)}
            selectedId={currentCatalogEntry?.id}
            onSelect={(id) => onModelChange(id)}
            footerNote={
              catalogApproximate ? (
                <div className='video-quality-pill__model-note' data-testid='video-model-approximate-note'>
                  {t('credits.video.modelApproximateNote', {
                    defaultValue: 'Richtpreise aus dem Offline-Katalog',
                  })}
                </div>
              ) : undefined
            }
          />
        </div>
      ) : onModelChange && models.length > 1 ? (
        <div className='video-quality-pill__group' data-testid='video-model-group'>
          <span className='video-quality-pill__label'>{t('credits.video.modelLabel', { defaultValue: 'Modell' })}</span>
          <div
            className='video-quality-pill__options'
            role='radiogroup'
            aria-label={t('credits.video.modelLabel', { defaultValue: 'Modell' })}
          >
            {models.map((model) => {
              const selected = model === preview.plan.model;
              return (
                <button
                  key={model}
                  type='button'
                  role='radio'
                  aria-checked={selected}
                  className={`video-quality-pill__option${selected ? ' is-selected' : ''}`}
                  data-testid={`video-model-option-${model}`}
                  onClick={() => onModelChange(model)}
                >
                  {model === 'grok-imagine-video-1.5' ? 'Grok Video 1.5' : 'Grok Video'}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* RESOLUTION. Catalog mode: a dropdown filtered to the SELECTED model's
          supported_resolutions — an impossible resolution is unselectable.
          Legacy mode: the established tier radios. */}
      {catalog && currentCatalogEntry ? (
        currentCatalogEntry.resolutions !== null && currentCatalogEntry.resolutions.length > 1 ? (
          <div className='video-quality-pill__group' data-testid='video-resolution-group'>
            <span className='video-quality-pill__label'>
              {t('credits.video.qualityLabel', { defaultValue: 'Qualität' })}
            </span>
            <MediaPillDropdown
              open={openDropdown === 'resolution'}
              onToggle={() => setOpenDropdown((open) => (open === 'resolution' ? null : 'resolution'))}
              onClose={() => setOpenDropdown(null)}
              ariaLabel={t('credits.video.qualityLabel', { defaultValue: 'Qualität' })}
              triggerTestId='video-resolution-dropdown-trigger'
              listTestId='video-resolution-dropdown'
              estimatedRows={currentCatalogEntry.resolutions.length}
              triggerContent={effectiveResolution}
            >
              {currentCatalogEntry.resolutions.map((option) => {
                const selected = option === selection?.resolution;
                const estimate = estimateVideoCatalogCredits({
                  entry: currentCatalogEntry,
                  resolution: option,
                  durationSeconds: effectiveDuration,
                });
                return (
                  <button
                    key={option}
                    type='button'
                    role='option'
                    aria-selected={selected}
                    data-eve-composite-owner='listbox'
                    className={`video-quality-pill__model-entry${selected ? ' is-selected' : ''}`}
                    data-testid={`video-resolution-option-${option}`}
                    onClick={() => {
                      onResolutionChange?.(option);
                      const tier = tierIdForResolution(option);
                      if (tier !== undefined) onChange(tier);
                      setOpenDropdown(null);
                    }}
                  >
                    <span className='video-quality-pill__model-name'>{option}</span>
                    <span className='video-quality-pill__model-price'>
                      {formatVideoCatalogPrice(videoCatalogUsdPerSecond(currentCatalogEntry, option))}
                    </span>
                    {estimate !== undefined && (
                      <span className='video-quality-pill__model-estimate'>
                        {t('credits.video.modelEstimate', {
                          defaultValue: '≈ {{credits}} Credits',
                          credits: estimate.credits,
                        })}
                      </span>
                    )}
                    {selected && <CheckSmall size={13} className='video-quality-pill__check' />}
                  </button>
                );
              })}
            </MediaPillDropdown>
          </div>
        ) : (
          <div className='video-quality-pill__group' data-testid='video-resolution-group'>
            <span className='video-quality-pill__label'>
              {t('credits.video.qualityLabel', { defaultValue: 'Qualität' })}
            </span>
            <span className='video-quality-pill__option is-selected' data-testid='video-resolution-fixed'>
              {currentCatalogEntry.resolutions?.[0] ?? preview.plan.resolution}
            </span>
          </div>
        )
      ) : (
        <div className='video-quality-pill__group'>
          <span className='video-quality-pill__label'>
            {t('credits.video.qualityLabel', { defaultValue: 'Qualität' })}
          </span>
          <div
            className='video-quality-pill__options'
            role='radiogroup'
            aria-label={t('credits.video.qualityLabel', { defaultValue: 'Qualität' })}
          >
            {tiers.map((tier) => {
              const selected = effectiveTier !== undefined && tier.id === effectiveTier.id;
              return (
                <button
                  key={tier.id}
                  type='button'
                  role='radio'
                  aria-checked={selected}
                  className={`video-quality-pill__option${selected ? ' is-selected' : ''}`}
                  data-testid={`video-quality-option-${tier.id}`}
                  onClick={() => onChange(tier.id)}
                >
                  {tier.resolution}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* DURATION. Catalog mode: a dropdown of the model's supported_durations,
          scrollable when long. Legacy mode: the established 5/10/15 radios. */}
      {onDurationChange ? (
        catalog && currentCatalogEntry ? (
          currentCatalogEntry.durations !== null ? (
            <div className='video-quality-pill__group' data-testid='video-duration-group'>
              <span className='video-quality-pill__label'>
                {t('credits.video.durationLabel', { defaultValue: 'Dauer' })}
              </span>
              <MediaPillDropdown
                open={openDropdown === 'duration'}
                onToggle={() => setOpenDropdown((open) => (open === 'duration' ? null : 'duration'))}
                onClose={() => setOpenDropdown(null)}
                ariaLabel={t('credits.video.durationLabel', { defaultValue: 'Dauer' })}
                triggerTestId='video-duration-dropdown-trigger'
                listTestId='video-duration-dropdown'
                estimatedRows={currentCatalogEntry.durations.length}
                triggerContent={`${effectiveDuration}s`}
              >
                {currentCatalogEntry.durations
                  .toSorted((a, b) => a - b)
                  .map((seconds) => {
                    const selected = seconds === selection?.durationSeconds;
                    const estimate = estimateVideoCatalogCredits({
                      entry: currentCatalogEntry,
                      resolution: selection?.resolution ?? null,
                      durationSeconds: seconds,
                    });
                    return (
                      <button
                        key={seconds}
                        type='button'
                        role='option'
                        aria-selected={selected}
                        data-eve-composite-owner='listbox'
                        className={`video-quality-pill__model-entry${selected ? ' is-selected' : ''}`}
                        data-testid={`video-duration-option-${seconds}`}
                        onClick={() => {
                          onDurationChange(seconds);
                          setOpenDropdown(null);
                        }}
                      >
                        <span className='video-quality-pill__model-name'>{seconds}s</span>
                        {estimate !== undefined && (
                          <span className='video-quality-pill__model-estimate'>
                            {t('credits.video.modelEstimate', {
                              defaultValue: '≈ {{credits}} Credits',
                              credits: estimate.credits,
                            })}
                          </span>
                        )}
                        {selected && <CheckSmall size={13} className='video-quality-pill__check' />}
                      </button>
                    );
                  })}
              </MediaPillDropdown>
            </div>
          ) : null
        ) : (
          <div className='video-quality-pill__group' data-testid='video-duration-group'>
            <span className='video-quality-pill__label'>
              {t('credits.video.durationLabel', { defaultValue: 'Dauer' })}
            </span>
            <div
              className='video-quality-pill__options'
              role='radiogroup'
              aria-label={t('credits.video.durationLabel', { defaultValue: 'Dauer' })}
            >
              {[5, 10, 15]
                .filter((seconds) => seconds <= preview.plan.maxDurationSeconds)
                .map((seconds) => {
                  const selected = seconds === (durationSeconds ?? DEFAULT_VIDEO_DURATION_SECONDS);
                  return (
                    <button
                      key={seconds}
                      type='button'
                      role='radio'
                      aria-checked={selected}
                      className={`video-quality-pill__option${selected ? ' is-selected' : ''}`}
                      data-testid={`video-duration-option-${seconds}`}
                      onClick={() => onDurationChange(seconds)}
                    >
                      {seconds}s
                    </button>
                  );
                })}
            </div>
          </div>
        )
      ) : null}

      {showVoices && (
        <div
          className='video-quality-pill__options'
          role='group'
          data-testid='video-preset-voices'
          aria-label={t('credits.video.voiceLabel', { defaultValue: 'Stimme' })}
        >
          {voices.map((voice) => {
            const selected = chosenVoiceIds.includes(voice.id);
            // The ceiling is enforced in the core too; disabling here is so the
            // user is not invited to make a choice that would be refused.
            const atCeiling = !selected && chosenVoiceIds.length >= MAX_VIDEO_REFERENCE_AUDIOS;
            return (
              <button
                key={voice.id}
                type='button'
                role='checkbox'
                aria-checked={selected}
                disabled={atCeiling}
                className={`video-quality-pill__option${selected ? ' is-selected' : ''}`}
                data-testid={`video-preset-voice-${voice.id}`}
                onClick={() => onVoiceToggle?.(voice.id)}
              >
                {voice.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Price of the CURRENT choice, for the model it will ACTUALLY use.
          Informational — this line never gates. */}
      <span className='video-quality-pill__estimate' data-testid='video-quality-pill-estimate'>
        {t('credits.video.inlineEstimate', {
          defaultValue: 'ca. {{credits}} Credits / {{sec}}s',
          credits: preview.estimatedCredits,
          sec: preview.durationSeconds,
        })}
      </span>
    </div>
  );
};

export default VideoQualityPill;
