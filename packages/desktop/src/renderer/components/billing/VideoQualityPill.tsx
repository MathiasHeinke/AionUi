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
import { estimateVideoCost, VIDEO_TIERS, type VideoQualityTier } from '@/common/config/videoCostCore';
import './billing.css';

export interface VideoQualityPillProps {
  /** The currently selected tier. */
  value: VideoQualityTier;
  /** Select a tier. Called on click only — never automatically. */
  onChange: (tierId: VideoQualityTier) => void;
  /** Clip duration in seconds, for the credit estimate (defaults to the core's). */
  durationSeconds?: number;
  /** Hide the control entirely (the draft does not route to video). */
  visible: boolean;
}

const VideoQualityPill: React.FC<VideoQualityPillProps> = ({ value, onChange, durationSeconds, visible }) => {
  const { t } = useTranslation();

  if (!visible) return null;

  const preview = estimateVideoCost({ durationSeconds, tierId: value });

  return (
    <div className='video-quality-pill' data-testid='video-quality-pill' data-selected-tier={value}>
      <span className='video-quality-pill__label'>{t('credits.video.qualityLabel', { defaultValue: 'Qualität' })}</span>

      <div
        className='video-quality-pill__options'
        role='radiogroup'
        aria-label={t('credits.video.qualityLabel', { defaultValue: 'Qualität' })}
      >
        {VIDEO_TIERS.map((tier) => {
          const selected = tier.id === value;
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
              {tier.isUpgrade
                ? t('credits.video.tierHd', { defaultValue: 'HD-Qualität' })
                : t('credits.video.tierFast', { defaultValue: 'Fast (Standard)' })}
              <span className='video-quality-pill__resolution'>{tier.resolution}</span>
            </button>
          );
        })}
      </div>

      {/* Price of the CURRENT choice. Informational — this line never gates. */}
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
