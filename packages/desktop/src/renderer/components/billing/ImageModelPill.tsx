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
 * tiers the SERVER ranked via `curated_rank`, in that order; nothing is ever
 * invented client-side), everything else behind 'Weitere anzeigen', and
 * per-row credit estimates from the registry's `generate_credits` quotes.
 * Image "resolutions" are the 1K/2K tiers: a second dropdown, filtered to the
 * SELECTED model's `resolutions` — an unsupported tier is unselectable, and a
 * stale selection is auto-picked to the model's first tier and reported
 * upward, never a late error.
 *
 * THE SERVER CONTRACT IS TIER-BASED. Picking a row fires `onChange` with the
 * TIER id the registry maps that model to (quality/max/seedream-pro/…) — exactly what
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
 *
 * WHAT THE FALLBACK MAY OFFER (2026-08-18). Tier ids are now MODEL IDENTITIES
 * (`seedream-pro`, `grok-2`, …), not the old conceptual three. Enumerating all
 * of them without a registry would mean naming vendor models the client has
 * not proven the server offers — precisely the invention this component
 * refuses for prices. So the unproven fallback lists only the tiers this
 * client can name from its OWN approved copy ({@link FALLBACK_TIER_LABELS}:
 * Qualität and MAX). Fewer honest options is the fail-closed direction; the
 * full catalog appears the moment the registry is proven.
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckSmall } from '@renderer/components/icons';
import {
  commandEveImageModelProvider,
  effectiveImageReferenceCeiling,
  isCommandEveImageModelTierId,
  listImageModelsBeyondCurated,
  resolveImageModelCuratedTiers,
  type CommandEveImageModelRegistry,
  type CommandEveImageModelResolution,
  type CommandEveImageModelTierId,
  type CommandEveImageModelTierSpec,
} from '@/common/config/eveImageModelRegistryCore';
import {
  COMMAND_EVE_MANAGED_IMAGE_MAX_REFERENCES,
  COMMAND_EVE_MANAGED_IMAGE_RESOLUTIONS,
} from '@/common/config/eveManagedImageGenerationCore';
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
  /**
   * In edit mode, expose only models the server registry proves can accept
   * reference images and quote only their edit prices.
   */
  operation?: 'generate' | 'edit';
  /**
   * How many reference images the composer currently carries. Used ONLY to
   * surface the selected model's ceiling BEFORE sending — the pill never
   * blocks; the lane still refuses authoritatively.
   */
  referenceCount?: number;
}

/**
 * The ONLY tiers this client can name on its own — the two that carry
 * translated, approved copy in the locale bundles. Deliberately PARTIAL: a
 * tier missing here has no client-side name, and a model the server did not
 * prove is never announced from a hardcoded table.
 */
const FALLBACK_TIER_LABELS: Partial<Record<CommandEveImageModelTierId, { key: string; defaultValue: string }>> = {
  quality: { key: 'credits.image.tierQuality', defaultValue: 'Qualität' },
  max: { key: 'credits.image.tierMax', defaultValue: 'MAX' },
};

/** The fallback dropdown's rows, in a stable order. */
const FALLBACK_TIER_IDS = Object.keys(FALLBACK_TIER_LABELS) as CommandEveImageModelTierId[];

const ImageModelPill: React.FC<ImageModelPillProps> = ({
  value,
  onChange,
  visible,
  registry,
  resolution,
  onResolutionChange,
  operation = 'generate',
  referenceCount,
}) => {
  const { t } = useTranslation();
  // One open dropdown at a time (model vs resolution), same rule as the video pill.
  const [openDropdown, setOpenDropdown] = useState<'model' | 'resolution' | null>(null);
  const [internalResolution, setInternalResolution] = useState<CommandEveImageModelResolution>('1K');

  const availableSpecs = registry
    ? operation === 'edit'
      ? registry.tiers.filter((tier) => tier.supports_references)
      : registry.tiers
    : [];
  const selectedSpec = availableSpecs.find((tier) => tier.id === value);
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
  // A tier with no approved client-side copy falls back to its raw id rather
  // than to an invented German name.
  const tierLabelFor = (tierId: CommandEveImageModelTierId): string => {
    const label = FALLBACK_TIER_LABELS[tierId];
    return label ? t(label.key, { defaultValue: label.defaultValue }) : tierId;
  };

  // THE CEILING THE OPERATOR ACTUALLY MEETS, not the model's advertised one.
  // The lane caps every model at four references (bridge policy, artifact
  // bridge, managed-image service, and the gateway's own parse before any
  // reserve), so the binding limit is the LOWER of that cap and the model's
  // number. Rendering the raw 16 of gpt-image-2 would promise a fifth
  // reference this lane refuses — worse than silence, because the operator
  // would act on it. `null` still means nothing was proven; the pill then
  // claims nothing.
  const referenceCeiling = registry
    ? effectiveImageReferenceCeiling(registry, value, COMMAND_EVE_MANAGED_IMAGE_MAX_REFERENCES)
    : null;
  const referencesOverCeiling =
    referenceCeiling !== null && referenceCount !== undefined && referenceCount > referenceCeiling.ceiling;

  /**
   * An image edit always sends one reference: the selected source image.
   * `referenceCount` above is advisory attachment/ceiling state; those draft
   * attachments are not inputs to `eve_image_edit` today and therefore must
   * neither inflate nor erase the price shown for the actual paid request.
   */
  const quoteFor = (spec: CommandEveImageModelTierSpec, candidateResolution: CommandEveImageModelResolution): number =>
    operation === 'edit'
      ? spec.quotes.edit_credits[candidateResolution] + spec.quotes.per_input_reference_credits
      : spec.quotes.generate_credits[candidateResolution];

  // One registry tier -> one generic dropdown row. The row's estimate is the
  // registry's OWN operation quote for the current resolution tier (the row's
  // first tier when it cannot serve the current one) — never a client number.
  const toModelRow = (spec: CommandEveImageModelTierSpec): MediaModelRow => {
    const provider = commandEveImageModelProvider(spec);
    const rowResolution = spec.resolutions.includes(effectiveResolution) ? effectiveResolution : spec.resolutions[0];
    return {
      id: spec.id,
      name: spec.display_name,
      providerKey: provider.key,
      providerLabel: provider.label,
      estimateCredits: quoteFor(spec, rowResolution),
    };
  };

  const tierLabel = tierLabelFor(value);
  // A CONTROL THAT CANNOT CHANGE THE OUTCOME IS NOT A CHOICE. gpt-image-2's
  // only endpoint advertises no `resolution` parameter at all — it sizes at
  // its own discretion — so the server marks it `honors_resolution: false` and
  // the switch goes away here.
  //
  // THIS REUSES THE SINGLE-OPTION SEAM BELOW rather than adding a second
  // hiding rule: an empty option list takes the same `length > 1` branch a
  // 2K-only model already takes. One rule, two reasons to trip it.
  //
  // What does NOT change: the request body. The lane still sends a resolution
  // and the model still ignores it. Nothing here moves money either — the
  // server pins that a non-honouring tier must price both steps identically,
  // so a hidden switch can never silently choose the dearer one.
  //
  // Without a proven registry (`selectedSpec` undefined) the bounded 1K/2K
  // vocabulary stays, exactly as before: an unknown model is not a model
  // known to refuse.
  //
  // THE COMPARISON IS `!== false`, NOT A TRUTHINESS CHECK, and that is
  // deliberate. The parser already reads an omitted flag as `true` — an older
  // gateway must keep the control it has today, since this field can only ever
  // TAKE one away. Repeating that direction here keeps the invariant LOCAL:
  // a spec that reached this component without passing the parser (a test
  // fixture, a future second producer) would otherwise lose the switch on
  // `undefined` alone, which is the one failure this field must never have.
  // Only a PROVEN `false` hides it.
  const resolutionOptions = !selectedSpec
    ? COMMAND_EVE_MANAGED_IMAGE_RESOLUTIONS
    : selectedSpec.honors_resolution !== false
      ? selectedSpec.resolutions
      : [];
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
      // The ceiling and the overflow flag ride as DATA, not as new copy: the
      // composer owns the sentence a user reads, this control owns the fact.
      // A number the registry did not prove is simply absent.
      data-reference-ceiling={referenceCeiling?.ceiling ?? undefined}
      // WHICH limit bound it — the model's own number, or this lane's cap of
      // four. The composer needs the distinction to say WHY, and a reader of
      // the DOM should not have to re-derive it from two constants.
      data-reference-ceiling-bound-by={referenceCeiling?.boundBy ?? undefined}
      data-references-over-ceiling={referencesOverCeiling ? 'true' : undefined}
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
            recommended={resolveImageModelCuratedTiers(registry)
              .filter((tier) => availableSpecs.includes(tier))
              .map(toModelRow)}
            rest={listImageModelsBeyondCurated(registry)
              .filter((tier) => availableSpecs.includes(tier))
              .map(toModelRow)}
            selectedId={value}
            onSelect={(id) => {
              // The rows ARE the registry tiers, so the pick maps back to
              // the tier id exactly as the registry defines it — the value
              // the per-seat preference write carries.
              if (isCommandEveImageModelTierId(id)) onChange(id);
            }}
          />
        </div>
      ) : operation === 'generate' ? (
        <div className='image-model-pill__group' data-testid='image-model-group'>
          <MediaPillDropdown
            open={openDropdown === 'model'}
            onToggle={() => setOpenDropdown((open) => (open === 'model' ? null : 'model'))}
            onClose={() => setOpenDropdown(null)}
            ariaLabel={t('credits.video.modelChoose', { defaultValue: 'Modell wählen' })}
            triggerTestId='image-model-dropdown-trigger'
            listTestId='image-model-dropdown'
            triggerContent={tierLabel}
            estimatedRows={FALLBACK_TIER_IDS.length}
          >
            {FALLBACK_TIER_IDS.map((tierId) => {
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
      ) : null}

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
                        credits: quoteFor(selectedSpec, option),
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
          data-operation={operation}
          data-credits-1k={quoteFor(selectedSpec, '1K')}
          data-credits-2k={quoteFor(selectedSpec, '2K')}
          data-reference-surcharge={operation === 'edit' ? selectedSpec.quotes.per_input_reference_credits : undefined}
          data-priced-reference-count={operation === 'edit' ? 1 : undefined}
          title={
            operation === 'edit'
              ? t('credits.image.editEstimateTitle', {
                  defaultValue:
                    'Bearbeiten: {{edit1k}} Credits (1K) · {{edit2k}} (2K) · +{{perReference}} pro Referenzbild',
                  edit1k: selectedSpec.quotes.edit_credits['1K'],
                  edit2k: selectedSpec.quotes.edit_credits['2K'],
                  perReference: selectedSpec.quotes.per_input_reference_credits,
                })
              : undefined
          }
        >
          {t('credits.image.inlineEstimate', {
            defaultValue: 'ca. {{credits1k}} Credits (1K) · {{credits2k}} (2K)',
            credits1k: quoteFor(selectedSpec, '1K'),
            credits2k: quoteFor(selectedSpec, '2K'),
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
