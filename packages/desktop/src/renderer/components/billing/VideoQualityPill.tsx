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
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_VIDEO_DURATION_SECONDS,
  estimateVideoCost,
  listAvailableVideoModels,
  listAvailableVideoTiers,
  MAX_VIDEO_REFERENCE_AUDIOS,
  type VideoModeKind,
  type VideoModelId,
  type VideoPresetVoice,
  type VideoQualityTier,
  type VideoSeatCapabilities,
} from '@/common/config/videoCostCore';
import './billing.css';

export interface VideoQualityPillProps {
  /** The currently selected tier. */
  value: VideoQualityTier;
  /** Select a tier. Called on click only — never automatically. */
  onChange: (tierId: VideoQualityTier) => void;
  /** Explicit contextual model selection. Absent retains automatic routing. */
  modelId?: VideoModelId;
  onModelChange?: (modelId: VideoModelId) => void;
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
  /** The preset voices this seat may pick from. Rendered only when entitled. */
  presetVoices?: readonly VideoPresetVoice[];
  /** The currently selected preset voice ids (at most MAX_VIDEO_REFERENCE_AUDIOS). */
  selectedVoiceIds?: readonly string[];
  onVoiceToggle?: (voiceId: string) => void;
}

const VideoQualityPill: React.FC<VideoQualityPillProps> = ({
  value,
  onChange,
  modelId,
  onModelChange,
  durationSeconds,
  onDurationChange,
  visible,
  modeKind,
  capabilities,
  presetVoices,
  selectedVoiceIds,
  onVoiceToggle,
}) => {
  const { t } = useTranslation();

  if (!visible) return null;

  const models = listAvailableVideoModels({
    modeKind,
    ...(capabilities === undefined ? {} : { capabilities }),
  });
  const effectiveModelId = modelId !== undefined && models.includes(modelId) ? modelId : undefined;

  // Only what this request can ACTUALLY produce for the selected model. A model
  // switch can remove 1080p immediately; an impossible stale tier is represented
  // by the economical default below, never by a price for another request.
  const tiers = listAvailableVideoTiers({
    modeKind,
    ...(effectiveModelId === undefined ? {} : { modelId: effectiveModelId }),
    ...(capabilities === undefined ? {} : { capabilities }),
  });
  if (tiers.length === 0) return null;
  const effectiveTier = tiers.find((tier) => tier.id === value) ?? tiers.find((tier) => tier.isDefault) ?? tiers[0];

  // ONE resolution of mode + tier + capability, shared with the send path. The
  // pill does not recompute a price of its own — a second derivation is a second
  // answer, and the one the user reads must be the one the request carries.
  const preview = estimateVideoCost({
    modeKind,
    tierId: effectiveTier.id,
    ...(effectiveModelId === undefined ? {} : { modelId: effectiveModelId }),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(capabilities === undefined ? {} : { capabilities }),
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

  return (
    <div
      className='video-quality-pill'
      data-testid='video-quality-pill'
      data-selected-tier={effectiveTier.id}
      data-mode={modeKind}
      data-model={preview.plan.model}
      data-duration-seconds={preview.plan.durationSeconds}
    >
      {onModelChange && models.length > 1 ? (
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

      <div className='video-quality-pill__group'>
        <span className='video-quality-pill__label'>{t('credits.video.qualityLabel', { defaultValue: 'Qualität' })}</span>
        <div
          className='video-quality-pill__options'
          role='radiogroup'
          aria-label={t('credits.video.qualityLabel', { defaultValue: 'Qualität' })}
        >
          {tiers.map((tier) => {
            const selected = tier.id === effectiveTier.id;
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

      {onDurationChange ? (
        <div className='video-quality-pill__group' data-testid='video-duration-group'>
          <span className='video-quality-pill__label'>{t('credits.video.durationLabel', { defaultValue: 'Dauer' })}</span>
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
