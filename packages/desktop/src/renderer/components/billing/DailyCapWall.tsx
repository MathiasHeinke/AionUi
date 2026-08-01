/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The fair-use DAILY-CAP wall. Sibling of QuotaExhaustedWall, but for a
 * different signal: not "your wallet is empty" (402) but "this access hit its
 * per-day fair-use ceiling" (429). It is an ABUSE cap, not an allowance — the
 * server's own note on the counter reads "Not a free allowance: every turn it
 * lets through is still metered".
 *
 * NEVER a buy link. This wall does not sell, and not out of politeness: buying
 * credits does not lift a fair-use cap, so a purchase CTA here would take money
 * for something it cannot deliver. It states the fact and closes. It reuses the same
 * idle-suppression gate as the 402 wall (an idle wall has no purpose), so it
 * surfaces only when a turn was actually in flight.
 */

import React from 'react';
import { Button, Modal } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';

import { shouldSurfaceQuotaWall } from '@/common/config/creditsCore';

export interface DailyCapWallProps {
  /** True when the fair-use daily cap was hit (from useQuotaWall). */
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
          {t('credits.dailyCap.title', { defaultValue: 'Tageslimit erreicht' })}
        </h2>
        <p className='daily-cap-wall__body-text m-t-8px text-14px leading-22px text-t-secondary'>
          {t('credits.dailyCap.body', {
            defaultValue:
              'Für heute ist das Fair-Use-Tageslimit dieses Zugangs erreicht. Es setzt sich morgen zurück; Anfragen laufen weiterhin über deine Credits. Die lokale KI kannst du jederzeit nutzen.',
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
