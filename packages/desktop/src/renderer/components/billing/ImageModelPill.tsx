/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Inline image-model selector — a PREFERENCE PICKER, never a gate (MAT-1769).
 *
 * MAT-1773 (PACKAGE A): with a proven registry this is the SAME dropdown idiom
 * as the video pill — the shared `MediaModelDropdown` lists the registry's
 * tier-mapped models with provider chips, an 'Empfohlen' curated section (the
 * registry's own tiers in server order; nothing is ever invented client-side)
 * and per-row credit estimates from the registry's `generate_credits` quotes.
 * Image "resolutions" are the 1K/2K tiers: a second dropdown, filtered to the
 * SELECTED model's `resolutions` — an unsupported tier is unselectable, and a
 * stale selection is auto-picked to the model's first tier and reported
 * upward, never a late error.
 *
 * THE SERVER CONTRACT IS TIER-BASED. Picking a row fires `onChange` with the
 * TIER id the registry maps that model to (fast/quality/max) — exactly what
 * the per-seat preference write (`imageModelPreferenceSet`) carries. The
 * component never names a provider model to the send path.
 *
 * THE PRICE RULE. Every credit figure shown here comes from the SERVER-OWNED
 * registry (`registry` prop, answered by Main through the non-billable
 * capabilities surface). When the registry is unavailable the control stays
 * usable — a preference can be chosen without a price — but it degrades to the
 * generic tier dropdown with an honest "price unavailable" line: no
 * display names, no dropdown, no client-side fallback number. A stale price
 * would be a lie at the exact moment of choosing. The only thing that may
 * REFUSE an image is the lane itself: generation fails closed when the
 * registry cannot be proven.
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckSmall } from '@renderer/components/icons';
import {
  COMMAND_EVE_IMAGE_MODEL_TIER_IDS,
  commandEveImageModelProvider,
  getCommandEveImageModelTierSpec,
  isCommandEveImageModelTierId,
  listImageModelsBeyondCurated,
  resolveImageModelCuratedTiers,
  type CommandEveImageModelRegistry,
  type CommandEveImageModelResolution,
  type CommandEveImageModelTierId,
  type CommandEveImageModelTierSpec,
} from '@/common/config/eveImageModelRegistryCore';
import { COMMAND_EVE_MANAGED_IMAGE_RESOLUTIONS } from '@/common/config/eveManagedImageGenerationCore';
import {
  MediaModelDropdown,
  MediaPillDropdown,
  type MediaModelRow,
} from '@/renderer/components/billing/MediaModelDropdown';
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
   * "nothing proven" — the fail-closed reading: a generic tier dropdown with
   * no model names or prices, and the estimate says so.
   */
  registry?: CommandEveImageModelRegistry | null;
  /**
   * The selected image resolution ('1K'/'2K'). Absent follows an internal
   * default — the server contract is tier-based, so this is presentational
   * (the estimate and the resolution rows quote it) until the contract
   * carries it.
   */
  resolution?: CommandEveImageModelResolution | null;
  onResolutionChange?: (resolution: CommandEveImageModelResolution) => void;
}

const TIER_LABELS: Record<CommandEveImageModelTierId, { key: string; defaultValue: string }> = {
  fast: { key: 'credits.image.tierFast', defaultValue: 'Schnell' },
  quality: { key: 'credits.image.tierQuality', defaultValue: 'Qualität' },
  max: { key: 'credits.image.tierMax', defaultValue: 'MAX' },
};

const ImageModelPill: React.FC<ImageModelPillProps> = ({
  value,
  onChange,
  visible,
  registry,
  resolution,
  onResolutionChange,
}) => {
  const { t } = useTranslation();
  // One open dropdown at a time (model vs resolution), same rule as the video pill.
  const [openDropdown, setOpenDropdown] = useState<'model' | 'resolution' | null>(null);
  const [internalResolution, setInternalResolution] = useState<CommandEveImageModelResolution>('1K');

  const selectedSpec = registry ? getCommandEveImageModelTierSpec(registry, value) : undefined;
  const requestedResolution = resolution ?? internalResolution;
  const effectiveResolution: CommandEveImageModelResolution =
    selectedSpec && !selectedSpec.resolutions.includes(requestedResolution)
      ? selectedSpec.resolutions[0]
      : requestedResolution;

  // A model switch can remove the current resolution tier: auto-pick the
  // model's first tier and report it upward, so the change the trigger shows
  // is real state — never a late error. Entry change only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!selectedSpec) return;
    if (selectedSpec.resolutions.includes(requestedResolution)) return;
    const next = selectedSpec.resolutions[0];
    setInternalResolution(next);
    onResolutionChange?.(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSpec?.id]);

  if (!visible) return null;

  // FAIL-CLOSED FALLBACK: without a proven registry there are no display
  // names and no prices to list — only generic tier names stay, in the same
  // compact dropdown idiom. The estimate is the honest unavailable line and
  // the preference itself stays selectable either way.
  const tierLabelFor = (tierId: CommandEveImageModelTierId): string =>
    t(TIER_LABELS[tierId].key, { defaultValue: TIER_LABELS[tierId].defaultValue });

  // One registry tier -> one generic dropdown row. The row's estimate is the
  // registry's OWN generate quote for the current resolution tier (the row's
  // first tier when it cannot serve the current one) — never a client number.
  const toModelRow = (spec: CommandEveImageModelTierSpec): MediaModelRow => {
    const provider = commandEveImageModelProvider(spec);
    const rowResolution = spec.resolutions.includes(effectiveResolution) ? effectiveResolution : spec.resolutions[0];
    return {
      id: spec.id,
      name: spec.display_name,
      providerKey: provider.key,
      providerLabel: provider.label,
      estimateCredits: spec.quotes.generate_credits[rowResolution],
    };
  };

  const tierLabel = tierLabelFor(value);
  const resolutionOptions = selectedSpec?.resolutions ?? COMMAND_EVE_MANAGED_IMAGE_RESOLUTIONS;
  const resolutionLabelFor = (candidate: CommandEveImageModelResolution): string =>
    candidate === '2K'
      ? t('conversation.workProduct.image.qualityHigh', { defaultValue: 'Hoch' })
      : t('conversation.workProduct.image.qualityStandard', { defaultValue: 'Standard' });

  return (
    <div
      className='image-model-pill'
      data-testid='image-model-pill'
      data-selected-tier={value}
      data-resolution={effectiveResolution}
    >
      <span className='image-model-pill__label'>{t('credits.image.modelLabel', { defaultValue: 'Bildmodell' })}</span>

      {registry ? (
        <div className='image-model-pill__group' data-testid='image-model-group'>
          <MediaModelDropdown
            open={openDropdown === 'model'}
            onToggle={() => setOpenDropdown((open) => (open === 'model' ? null : 'model'))}
            onClose={() => setOpenDropdown(null)}
            ariaLabel={t('credits.video.modelChoose', { defaultValue: 'Modell wählen' })}
            testIdPrefix='image-model'
            triggerContent={selectedSpec?.display_name ?? tierLabel}
            triggerActive={value !== registry.default_tier}
            recommended={resolveImageModelCuratedTiers(registry).map(toModelRow)}
            rest={listImageModelsBeyondCurated(registry).map(toModelRow)}
            selectedId={value}
            onSelect={(id) => {
              // The rows ARE the registry tiers, so the pick maps back to
              // the tier id exactly as the registry defines it — the value
              // the per-seat preference write carries.
              if (isCommandEveImageModelTierId(id)) onChange(id);
            }}
          />
        </div>
      ) : (
        <div className='image-model-pill__group' data-testid='image-model-group'>
          <MediaPillDropdown
            open={openDropdown === 'model'}
            onToggle={() => setOpenDropdown((open) => (open === 'model' ? null : 'model'))}
            onClose={() => setOpenDropdown(null)}
            ariaLabel={t('credits.video.modelChoose', { defaultValue: 'Modell wählen' })}
            triggerTestId='image-model-dropdown-trigger'
            listTestId='image-model-dropdown'
            triggerContent={tierLabel}
            estimatedRows={COMMAND_EVE_IMAGE_MODEL_TIER_IDS.length}
          >
            {COMMAND_EVE_IMAGE_MODEL_TIER_IDS.map((tierId) => {
              const selected = tierId === value;
              return (
                <button
                  key={tierId}
                  type='button'
                  role='option'
                  aria-selected={selected}
                  data-eve-composite-owner='listbox'
                  className={`video-quality-pill__model-entry${selected ? ' is-selected' : ''}`}
                  data-testid={`image-model-option-${tierId}`}
                  onClick={() => {
                    onChange(tierId);
                    setOpenDropdown(null);
                  }}
                >
                  <span className='video-quality-pill__model-name'>{tierLabelFor(tierId)}</span>
                  {selected ? <CheckSmall size={13} className='video-quality-pill__check' /> : null}
                </button>
              );
            })}
          </MediaPillDropdown>
        </div>
      )}

      {/* Resolution is an exact managed-lane contract value. With a proven
          registry the options are filtered to the selected model; without it,
          the lane's bounded 1K/2K vocabulary remains available but unpriced. */}
      {resolutionOptions.length > 1 ? (
        <div className='image-model-pill__group' data-testid='image-resolution-group'>
          <MediaPillDropdown
            open={openDropdown === 'resolution'}
            onToggle={() => setOpenDropdown((open) => (open === 'resolution' ? null : 'resolution'))}
            onClose={() => setOpenDropdown(null)}
            ariaLabel={t('credits.video.qualityLabel', { defaultValue: 'Qualität' })}
            triggerTestId='image-resolution-dropdown-trigger'
            listTestId='image-resolution-dropdown'
            estimatedRows={resolutionOptions.length}
            triggerContent={resolutionLabelFor(effectiveResolution)}
          >
            {resolutionOptions.map((option) => {
              const selected = option === effectiveResolution;
              return (
                <button
                  key={option}
                  type='button'
                  role='option'
                  aria-selected={selected}
                  data-eve-composite-owner='listbox'
                  className={`video-quality-pill__model-entry${selected ? ' is-selected' : ''}`}
                  data-testid={`image-resolution-option-${option}`}
                  onClick={() => {
                    setInternalResolution(option);
                    onResolutionChange?.(option);
                    setOpenDropdown(null);
                  }}
                >
                  <span className='video-quality-pill__model-name'>
                    {resolutionLabelFor(option)} · {option}
                  </span>
                  {selectedSpec ? (
                    <span className='video-quality-pill__model-estimate'>
                      {t('credits.video.modelEstimate', {
                        defaultValue: '≈ {{credits}} Credits',
                        credits: selectedSpec.quotes.generate_credits[option],
                      })}
                    </span>
                  ) : null}
                  {selected ? <CheckSmall size={13} className='video-quality-pill__check' /> : null}
                </button>
              );
            })}
          </MediaPillDropdown>
        </div>
      ) : null}

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
