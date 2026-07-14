/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The free-tier DAILY-cap wall (v1.6.x). Sibling of QuotaExhaustedWall, but for
 * a fundamentally different signal: the free tier has no credit tank — it has a
 * per-day action allowance. When it is spent, EVE simply pauses until tomorrow.
 *
 * Founder doctrine (free tier): NEVER a buy link. This wall does not sell — it
 * reassures ("morgen geht es kostenlos weiter") and closes. It reuses the same
 * idle-suppression gate as the 402 wall (an idle wall has no purpose), so it
 * surfaces only when a turn was actually in flight.
 */

import React from 'react';
import { Button, Modal } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';

import { shouldSurfaceQuotaWall } from '@/common/config/creditsCore';

export interface DailyCapWallProps {
  /** True when the free daily allowance was just spent (from useQuotaWall). */
  reached: boolean;
  /** Whether a turn was in flight when the cap hit (drives idle-suppression). */
  jobInFlight: boolean;
  /** Dismiss the wall. */
  onClose: () => void;
}

const DailyCapWall: React.FC<DailyCapWallProps> = ({ reached, jobInFlight, onClose }) => {
  const { t } = useTranslation();

  // Same single gate the 402 wall uses: never surface an idle wall.
  const surface = shouldSurfaceQuotaWall({ jobInFlight, hasQuotaSignal: reached });
  if (!surface) return null;

  return (
    <Modal visible title={null} footer={null} onCancel={onClose} maskClosable className='daily-cap-wall' escToExit>
      <div className='daily-cap-wall__body' data-testid='daily-cap-wall'>
        <h2 className='daily-cap-wall__title text-18px font-700 text-t-primary' data-testid='daily-cap-wall-title'>
          {t('credits.dailyCap.title', { defaultValue: 'Kostenloses Tageskontingent erreicht' })}
        </h2>
        <p className='daily-cap-wall__body-text m-t-8px text-14px leading-22px text-t-secondary'>
          {t('credits.dailyCap.body', {
            defaultValue:
              'Dein kostenloses Tageskontingent ist für heute aufgebraucht — morgen geht es kostenlos weiter. Du kannst jederzeit die lokale KI nutzen.',
          })}
        </p>
        <div className='daily-cap-wall__actions m-t-16px flex justify-end'>
          <Button type='primary' onClick={onClose} data-testid='daily-cap-wall-close'>
            {t('credits.dailyCap.close', { defaultValue: 'Alles klar' })}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default DailyCapWall;
