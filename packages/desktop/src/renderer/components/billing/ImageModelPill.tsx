/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inline image-model selector — a PREFERENCE PICKER, never a gate (MAT-1769).
 *
 * Exactly three choices: Schnell / Qualität / MAX. Same interaction layer as
 * the video-quality pill: radios in the composer's draft band, no modal, no
 * confirm, nothing that can intercept a send. The choice is a per-seat
 * preference that MAIN applies to the managed image generation/edit lane —
 * this component never names a provider model itself.
 *
 * THE PRICE RULE. Every credit figure shown here comes from the SERVER-OWNED
 * registry (`registry` prop, answered by Main through the non-billable
 * capabilities surface). When the registry is unavailable the control stays
 * usable — a preference can be chosen without a price — but the estimate
 * degrades to an honest "price unavailable" line. There is no client-side
 * fallback number to show instead; a stale price would be a lie at the exact
 * moment of choosing. The only thing that may REFUSE an image is the lane
 * itself: generation fails closed when the registry cannot be proven.
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  COMMAND_EVE_IMAGE_MODEL_TIER_IDS,
  getCommandEveImageModelTierSpec,
  type CommandEveImageModelRegistry,
  type CommandEveImageModelTierId,
} from '@/common/config/eveImageModelRegistryCore';
import './billing.css';

export interface ImageModelPillProps {
  /** The currently selected tier. */
  value: CommandEveImageModelTierId;
  /** Select a tier. Called on click only — never automatically. */
  onChange: (tierId: CommandEveImageModelTierId) => void;
  /** Hide the control entirely (not a managed EVE conversation). */
  visible: boolean;
  /**
   * The SERVER-OWNED registry as answered by Main. `null`/`undefined` means
   * "nothing proven" — the fail-closed reading: no display names, no prices,
   * and the estimate says so.
   */
  registry?: CommandEveImageModelRegistry | null;
}

const TIER_LABELS: Record<CommandEveImageModelTierId, { key: string; defaultValue: string }> = {
  fast: { key: 'credits.image.tierFast', defaultValue: 'Schnell' },
  quality: { key: 'credits.image.tierQuality', defaultValue: 'Qualität' },
  max: { key: 'credits.image.tierMax', defaultValue: 'MAX' },
};

const ImageModelPill: React.FC<ImageModelPillProps> = ({ value, onChange, visible, registry }) => {
  const { t } = useTranslation();

  if (!visible) return null;

  const selectedSpec = registry ? getCommandEveImageModelTierSpec(registry, value) : undefined;

  return (
    <div className='image-model-pill' data-testid='image-model-pill' data-selected-tier={value}>
      <span className='image-model-pill__label'>{t('credits.image.modelLabel', { defaultValue: 'Bildmodell' })}</span>

      <div
        className='image-model-pill__options'
        role='radiogroup'
        aria-label={t('credits.image.modelLabel', { defaultValue: 'Bildmodell' })}
      >
        {COMMAND_EVE_IMAGE_MODEL_TIER_IDS.map((tierId) => {
          const selected = tierId === value;
          const spec = registry ? getCommandEveImageModelTierSpec(registry, tierId) : undefined;
          const premium = spec ? spec.premium : tierId === 'max';
          return (
            <button
              key={tierId}
              type='button'
              role='radio'
              aria-checked={selected}
              title={spec?.display_name}
              className={`image-model-pill__option${selected ? ' is-selected' : ''}${premium ? ' image-model-pill__option--max' : ''}`}
              data-testid={`image-model-option-${tierId}`}
              onClick={() => onChange(tierId)}
            >
              {t(TIER_LABELS[tierId].key, { defaultValue: TIER_LABELS[tierId].defaultValue })}
              {spec && <span className='image-model-pill__model'>{spec.display_name}</span>}
            </button>
          );
        })}
      </div>

      {/* Price of the CURRENT choice, from the server registry only.
          Informational — this line never gates. */}
      {selectedSpec ? (
        <span
          className='image-model-pill__estimate'
          data-testid='image-model-pill-estimate'
          data-quote-state='available'
          title={t('credits.image.editEstimateTitle', {
            defaultValue: 'Bearbeiten: {{edit1k}} Credits (1K) · {{edit2k}} (2K) · +{{perReference}} pro Referenzbild',
            edit1k: selectedSpec.quotes.edit_credits['1K'],
            edit2k: selectedSpec.quotes.edit_credits['2K'],
            perReference: selectedSpec.quotes.per_input_reference_credits,
          })}
        >
          {t('credits.image.inlineEstimate', {
            defaultValue: 'ca. {{credits1k}} Credits (1K) · {{credits2k}} (2K)',
            credits1k: selectedSpec.quotes.generate_credits['1K'],
            credits2k: selectedSpec.quotes.generate_credits['2K'],
          })}
        </span>
      ) : (
        <span
          className='image-model-pill__estimate image-model-pill__estimate--unavailable'
          data-testid='image-model-pill-estimate'
          data-quote-state='unavailable'
        >
          {t('credits.image.estimateUnavailable', { defaultValue: 'Preis aktuell nicht verfügbar' })}
        </span>
      )}
    </div>
  );
};

export default ImageModelPill;
