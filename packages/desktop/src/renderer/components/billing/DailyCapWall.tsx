/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The UPSTREAM RATE-LIMIT wall. Sibling of QuotaExhaustedWall, but for a different
 * signal: not "your wallet is empty" (402) but "the provider is throttling this
 * access right now" (429).
 *
 * IT USED TO CLAIM A DAILY CAP THAT DOES NOT EXIST (fixed 1.820.2). The copy read
 * "Für heute ist das Fair-Use-Tageslimit dieses Zugangs erreicht. Es setzt sich morgen
 * zurück" / "It resets tomorrow", citing a per-user daily counter on the server. That
 * counter has been deleted: it sat behind an `if (deps.usage)` guard the production
 * entrypoint never satisfied, so it had never once fired and could not have produced
 * this 429. Every 429 that reaches this wall is UPSTREAM rate limiting — about request
 * RATE, over minutes, not a day — so "resets tomorrow" was a promise nothing kept, and
 * a user who waited a day was told to wait for nothing.
 *
 * The file, the component and the `eve_daily_cap` discriminator keep their names on
 * purpose: renaming them touches eight files and a set of i18n keys without changing a
 * word the user reads. That is naming debt, recorded here, not a live claim.
 *
 * NEVER a buy link. This wall does not sell, and not out of politeness: buying credits
 * does not lift someone else's rate limit, so a purchase CTA here would take money for
 * something it cannot deliver. It states the fact and closes. It reuses the same
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
          {t('credits.dailyCap.title', { defaultValue: 'Kurz ausgebremst' })}
        </h2>
        <p className='daily-cap-wall__body-text m-t-8px text-14px leading-22px text-t-secondary'>
          {t('credits.dailyCap.body', {
            defaultValue:
              'Der Modellanbieter hat gerade zu viele Anfragen in kurzer Zeit gesehen und blockt vorübergehend. Versuch es gleich noch einmal — dein Guthaben ist davon nicht betroffen, und die lokale KI kannst du jederzeit nutzen.',
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
