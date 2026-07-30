/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PARKED — NOT RENDERED ANYWHERE. Nothing imports this component.
 *
 * It was the pre-submit cost wall: a modal that asked the user to approve the
 * credits for a video they had just asked for. That confirmation is gone —
 * asking for a video is the authorisation for it — so the SendBox no longer
 * mounts this, and `useVideoCostWall` no longer has a visible/confirm/cancel
 * surface to drive it.
 *
 * Kept for one reason only: the 1080p/HD tier had no other selector, so removing
 * the wall also removed the only way to choose it. Whether HD comes back as a
 * non-blocking picker or is dropped is a product decision; this file is the
 * existing tier UI to build that from. If that decision goes the other way,
 * delete this file together with the `credits.video.*` strings and the
 * `video-cost-wall` CSS.
 *
 * Do not re-mount it as a gate. The brake that protects the spend is server-side:
 * `reservePaidLane` → `canAfford` answers 402 on `insufficient_credits` or
 * `spend_cap_exceeded` before the upstream call ever happens.
 */

import React, { useMemo, useState } from 'react';
import { Button, Modal, Switch } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_VIDEO_TIER_ID,
  estimateVideoCost,
  isExplicitUpgrade,
  type VideoQualityTier,
} from '@/common/config/videoCostCore';
import './billing.css';

export interface VideoCostWallProps {
  /** Whether the wall is open (a video request is pending confirmation). */
  visible: boolean;
  /** Clip duration in seconds (defaults to the core's typical clip length). */
  durationSeconds?: number;
  /** Cancel the pending video request (user backed out). */
  onCancel: () => void;
  /**
   * Confirm — the user explicitly pressed "fortfahren". Receives the resolved
   * tier so the caller fires the request at exactly the previewed price.
   */
  onConfirm: (resolved: { tierId: VideoQualityTier; estimatedCredits: number }) => void;
}

const VideoCostWall: React.FC<VideoCostWallProps> = ({ visible, durationSeconds, onCancel, onConfirm }) => {
  const { t } = useTranslation();

  // Start on the cheaper Fast/720p default; 1080p is an explicit upgrade toggle.
  const [upgrade, setUpgrade] = useState(false);
  const selectedTierId: VideoQualityTier = upgrade ? 'hd' : DEFAULT_VIDEO_TIER_ID;

  const preview = useMemo(
    () => estimateVideoCost({ durationSeconds, tierId: selectedTierId }),
    [durationSeconds, selectedTierId]
  );

  if (!visible) return null;

  const handleConfirm = () => {
    onConfirm({ tierId: preview.tier.id, estimatedCredits: preview.estimatedCredits });
  };

  return (
    <Modal visible title={null} footer={null} onCancel={onCancel} maskClosable className='video-cost-wall' escToExit>
      <div className='quota-exhausted-wall__body' data-testid='video-cost-wall'>
        <h2 className='quota-exhausted-wall__title' data-testid='video-cost-wall-title'>
          {t('credits.video.title', { defaultValue: 'Video erstellen' })}
        </h2>

        {/* Transparent cost preview — the explicit-confirm prompt. */}
        <p className='quota-exhausted-wall__math' data-testid='video-cost-wall-preview'>
          {t('credits.video.costPreview', {
            defaultValue: 'Dieses ~{{sec}}s-Video kostet ca. {{credits}} Credits — fortfahren?',
            sec: preview.durationSeconds,
            credits: preview.estimatedCredits,
          })}
        </p>

        {/* Fast/720p is the default; 1080p is an explicit, opt-in upgrade. */}
        <label className='quota-exhausted-wall__autoreload'>
          <Switch
            size='small'
            checked={upgrade}
            onChange={(checked) => setUpgrade(checked)}
            data-testid='video-cost-wall-upgrade'
          />
          <span>
            {t('credits.video.upgrade1080p', {
              defaultValue: 'Auf 1080p hochstufen (teurer)',
            })}
          </span>
        </label>

        <p className='quota-exhausted-wall__math' data-testid='video-cost-wall-tier'>
          {preview.tier.resolution}
          {' · '}
          {preview.isUpgrade
            ? t('credits.video.tierHd', { defaultValue: 'HD-Qualität' })
            : t('credits.video.tierFast', { defaultValue: 'Fast (Standard)' })}
        </p>

        <div className='quota-exhausted-wall__actions'>
          <Button type='primary' long shape='round' onClick={handleConfirm} data-testid='video-cost-wall-confirm'>
            {t('credits.video.confirm', {
              defaultValue: 'Fortfahren — {{credits}} Credits',
              credits: preview.estimatedCredits,
            })}
          </Button>
          <button
            type='button'
            className='quota-exhausted-wall__later'
            onClick={onCancel}
            data-testid='video-cost-wall-cancel'
          >
            {t('credits.video.cancel', { defaultValue: 'Abbrechen' })}
          </button>
        </div>
      </div>
    </Modal>
  );
};

// Keep the upgrade-explicitness guard discoverable next to the component that
// enforces it (the wall only ever upgrades after the user toggled the switch).
export { isExplicitUpgrade };

export default VideoCostWall;
