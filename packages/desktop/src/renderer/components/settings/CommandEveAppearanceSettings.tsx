/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Message, Modal, Slider, Switch, Tooltip } from '@arco-design/web-react';
import { Check, Delete, UploadOne } from '@renderer/components/icons';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { useThemeContext } from '@renderer/hooks/context/ThemeContext';
import {
  EVE_ACCENTS,
  EVE_VISUAL_LIMITS,
  type EveAccent,
  type EveAppearanceMode,
  type EveBackgroundFit,
  type EveVisualPreferences,
} from '@renderer/theme/visualPreferences';
import {
  COMMAND_EVE_BUILTIN_BACKGROUNDS,
  garbageCollectEveVisualBackgrounds,
  isEveBuiltinBackground,
  removeEveVisualBackground,
  resolveEveVisualBackground,
  swapEveVisualBackground,
} from '@renderer/theme/visualBackgroundAssets';
import './CommandEveAppearanceSettings.css';

const sliderNumber = (value: number | number[]): number => (typeof value === 'number' ? value : value[0]);

const MODE_OPTIONS: EveAppearanceMode[] = ['system', 'light', 'dark'];
const ACCENT_OPTIONS: EveAccent[] = ['blue', 'petrol', 'emerald', 'graphite'];
const FIT_OPTIONS: EveBackgroundFit[] = ['cover', 'contain', 'fill'];
const BUILTIN_BACKGROUND_IDS = COMMAND_EVE_BUILTIN_BACKGROUNDS.map((background) => background.id);

const moveRadioSelection = <T extends string>(
  event: React.KeyboardEvent<HTMLButtonElement>,
  options: readonly T[],
  current: T,
  onSelect: (next: T) => void
) => {
  const currentIndex = Math.max(0, options.indexOf(current));
  let nextIndex: number | undefined;

  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % options.length;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
    nextIndex = (currentIndex - 1 + options.length) % options.length;
  if (event.key === 'Home') nextIndex = 0;
  if (event.key === 'End') nextIndex = options.length - 1;
  if (nextIndex === undefined) return;

  event.preventDefault();
  const group = event.currentTarget.closest('[role="radiogroup"]');
  onSelect(options[nextIndex]);
  const focusNext = () => group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusNext);
  else focusNext();
};

const CommandEveAppearanceSettings: React.FC = () => {
  const { t } = useTranslation();
  const { theme, visualPreferences, setVisualPreferences } = useThemeContext();
  const [glassOpacity, setGlassOpacity] = useState(visualPreferences.glassOpacity);
  const [glassBlur, setGlassBlur] = useState(visualPreferences.glassBlur);
  const [backgroundIntensity, setBackgroundIntensity] = useState(visualPreferences.background.intensity);
  const [backgroundBlur, setBackgroundBlur] = useState(visualPreferences.background.blur);
  const [backgroundDim, setBackgroundDim] = useState(visualPreferences.background.dim);
  const visualPreferencesRef = useRef(visualPreferences);
  visualPreferencesRef.current = visualPreferences;
  const backgroundDataUrl = useMemo(
    () => resolveEveVisualBackground(visualPreferences.background.assetId),
    [visualPreferences.background.assetId]
  );
  const selectedBuiltinBackgroundId =
    visualPreferences.background.enabled && isEveBuiltinBackground(visualPreferences.background.assetId)
      ? visualPreferences.background.assetId!
      : BUILTIN_BACKGROUND_IDS[0];

  useEffect(() => setGlassOpacity(visualPreferences.glassOpacity), [visualPreferences.glassOpacity]);
  useEffect(() => setGlassBlur(visualPreferences.glassBlur), [visualPreferences.glassBlur]);
  useEffect(
    () => setBackgroundIntensity(visualPreferences.background.intensity),
    [visualPreferences.background.intensity]
  );
  useEffect(() => setBackgroundBlur(visualPreferences.background.blur), [visualPreferences.background.blur]);
  useEffect(() => setBackgroundDim(visualPreferences.background.dim), [visualPreferences.background.dim]);

  const update = (producer: (current: EveVisualPreferences) => EveVisualPreferences) => {
    void setVisualPreferences(producer).catch(() => Message.error(t('settings.commandEveAppearance.saveFailed')));
  };

  const updateBackground = (patch: Partial<EveVisualPreferences['background']>) => {
    update((current) => ({ ...current, background: { ...current.background, ...patch } }));
  };

  const selectBuiltinBackground = async (assetId: string) => {
    const previousAssetId = visualPreferencesRef.current.background.assetId;
    try {
      await setVisualPreferences((current) => ({
        ...current,
        background: { ...current.background, enabled: true, assetId },
      }));
      if (previousAssetId && !isEveBuiltinBackground(previousAssetId)) removeEveVisualBackground(previousAssetId);
      garbageCollectEveVisualBackgrounds(assetId);
    } catch {
      Message.error(t('settings.commandEveAppearance.saveFailed'));
    }
  };

  const uploadBackground = async () => {
    try {
      const files = await ipcBridge.dialog.showOpen.invoke({
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
      });
      if (!files?.[0]) return;
      const dataUrl = await ipcBridge.fs.getImageBase64.invoke({ path: files[0] });
      if (!dataUrl) throw new Error('background-read-failed');

      // Remove the previous bytes before writing a fresh opaque asset id. This
      // keeps quota use bounded while still invalidating memoized lookups.
      const swap = swapEveVisualBackground(dataUrl, visualPreferencesRef.current.background.assetId);
      try {
        await setVisualPreferences((current) => ({
          ...current,
          background: { ...current.background, enabled: true, assetId: swap.assetId },
        }));
      } catch (error) {
        swap.rollback();
        throw error;
      }
      garbageCollectEveVisualBackgrounds(swap.assetId);
    } catch {
      Message.error(t('settings.commandEveAppearance.backgroundUploadFailed'));
    }
  };

  const confirmRemoveBackground = () => {
    Modal.confirm({
      title: t('settings.commandEveAppearance.removeBackgroundTitle'),
      content: t('settings.commandEveAppearance.removeBackgroundBody'),
      okText: t('common.remove'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        const assetId = visualPreferencesRef.current.background.assetId;
        try {
          await setVisualPreferences((current) => ({
            ...current,
            background: { ...current.background, enabled: false, assetId: undefined },
          }));
          removeEveVisualBackground(assetId);
        } catch (error) {
          Message.error(t('settings.commandEveAppearance.saveFailed'));
          throw error;
        }
      },
    });
  };

  return (
    <div className='eve-appearance-settings'>
      <section className='eve-appearance-section' aria-labelledby='eve-appearance-mode-title'>
        <div className='eve-appearance-section__heading'>
          <div id='eve-appearance-mode-title' className='eve-appearance-section__title'>
            {t('settings.commandEveAppearance.mode')}
          </div>
          <div className='eve-appearance-section__description'>
            {t('settings.commandEveAppearance.modeDescription')}
          </div>
        </div>
        <div
          className='eve-segmented-control'
          role='radiogroup'
          aria-label={t('settings.commandEveAppearance.mode')}
          aria-orientation='horizontal'
        >
          {MODE_OPTIONS.map((mode) => (
            <button
              key={mode}
              type='button'
              role='radio'
              aria-checked={visualPreferences.mode === mode}
              tabIndex={visualPreferences.mode === mode ? 0 : -1}
              className='eve-segmented-control__option'
              data-testid={`eve-appearance-mode-${mode}`}
              onClick={() => update((current) => ({ ...current, mode }))}
              onKeyDown={(event) =>
                moveRadioSelection(event, MODE_OPTIONS, visualPreferences.mode, (next) =>
                  update((current) => ({ ...current, mode: next }))
                )
              }
            >
              {t(`settings.commandEveAppearance.mode_${mode}`)}
            </button>
          ))}
        </div>
      </section>

      <section className='eve-appearance-section' aria-labelledby='eve-appearance-accent-title'>
        <div className='eve-appearance-section__heading'>
          <div id='eve-appearance-accent-title' className='eve-appearance-section__title'>
            {t('settings.commandEveAppearance.accent')}
          </div>
          <div className='eve-appearance-section__description'>
            {t('settings.commandEveAppearance.accentDescription')}
          </div>
        </div>
        <div
          className='eve-accent-swatches'
          role='radiogroup'
          aria-label={t('settings.commandEveAppearance.accent')}
          aria-orientation='horizontal'
        >
          {ACCENT_OPTIONS.map((accent) => {
            const label = t(`settings.commandEveAppearance.accent_${accent}`);
            return (
              <Tooltip key={accent} content={label}>
                <button
                  type='button'
                  role='radio'
                  aria-label={label}
                  aria-checked={visualPreferences.accent === accent}
                  tabIndex={visualPreferences.accent === accent ? 0 : -1}
                  className='eve-accent-swatch'
                  data-testid={`eve-appearance-accent-${accent}`}
                  style={{ '--eve-swatch-color': EVE_ACCENTS[accent][theme].base } as React.CSSProperties}
                  onClick={() => update((current) => ({ ...current, accent }))}
                  onKeyDown={(event) =>
                    moveRadioSelection(event, ACCENT_OPTIONS, visualPreferences.accent, (next) =>
                      update((current) => ({ ...current, accent: next }))
                    )
                  }
                >
                  {visualPreferences.accent === accent ? <Check size={15} weight='bold' aria-hidden='true' /> : null}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </section>

      <section className='eve-appearance-section' aria-labelledby='eve-appearance-glass-title'>
        <div className='eve-appearance-section__heading'>
          <div id='eve-appearance-glass-title' className='eve-appearance-section__title'>
            {t('settings.commandEveAppearance.glass')}
          </div>
          <div className='eve-appearance-section__description'>
            {t('settings.commandEveAppearance.glassDescription')}
          </div>
        </div>
        <div className='eve-appearance-controls'>
          <label className='eve-appearance-control'>
            <span>{t('settings.commandEveAppearance.opacity')}</span>
            <span className='eve-appearance-control__value'>{Math.round(glassOpacity * 100)}%</span>
            <Slider
              min={EVE_VISUAL_LIMITS.glassOpacity.min}
              max={EVE_VISUAL_LIMITS.glassOpacity.max}
              step={0.01}
              value={glassOpacity}
              onChange={(value) => setGlassOpacity(sliderNumber(value))}
              onAfterChange={(value) => update((current) => ({ ...current, glassOpacity: sliderNumber(value) }))}
            />
          </label>
          <label className='eve-appearance-control'>
            <span>{t('settings.commandEveAppearance.blur')}</span>
            <span className='eve-appearance-control__value'>{Math.round(glassBlur)} px</span>
            <Slider
              min={EVE_VISUAL_LIMITS.glassBlur.min}
              max={EVE_VISUAL_LIMITS.glassBlur.max}
              step={1}
              value={glassBlur}
              disabled={visualPreferences.reducedEffects}
              onChange={(value) => setGlassBlur(sliderNumber(value))}
              onAfterChange={(value) => update((current) => ({ ...current, glassBlur: sliderNumber(value) }))}
            />
          </label>
          <label className='eve-appearance-toggle'>
            <span>
              <span className='eve-appearance-toggle__title'>{t('settings.commandEveAppearance.reducedEffects')}</span>
              <span className='eve-appearance-toggle__description'>
                {t('settings.commandEveAppearance.reducedEffectsDescription')}
              </span>
            </span>
            <Switch
              aria-label={t('settings.commandEveAppearance.reducedEffects')}
              checked={visualPreferences.reducedEffects}
              onChange={(checked) => update((current) => ({ ...current, reducedEffects: checked }))}
            />
          </label>
        </div>
      </section>

      <section className='eve-appearance-section' aria-labelledby='eve-appearance-background-title'>
        <div className='eve-appearance-section__heading eve-appearance-section__heading--row'>
          <div>
            <div id='eve-appearance-background-title' className='eve-appearance-section__title'>
              {t('settings.commandEveAppearance.background')}
            </div>
            <div className='eve-appearance-section__description'>
              {t('settings.commandEveAppearance.backgroundDescription')}
            </div>
          </div>
          <Button size='small' icon={<UploadOne size={15} />} onClick={() => void uploadBackground()}>
            {backgroundDataUrl
              ? t('settings.commandEveAppearance.replaceBackground')
              : t('settings.commandEveAppearance.chooseBackground')}
          </Button>
        </div>

        <div className='eve-background-options'>
          <div className='eve-background-options__label'>{t('settings.commandEveAppearance.builtInBackgrounds')}</div>
          <div
            className='eve-background-presets'
            role='radiogroup'
            aria-label={t('settings.commandEveAppearance.builtInBackgrounds')}
          >
            {COMMAND_EVE_BUILTIN_BACKGROUNDS.map((background) => {
              const selected =
                visualPreferences.background.enabled && visualPreferences.background.assetId === background.id;
              const label = t(background.labelKey);
              return (
                <button
                  key={background.id}
                  type='button'
                  role='radio'
                  aria-label={label}
                  aria-checked={selected}
                  tabIndex={selectedBuiltinBackgroundId === background.id ? 0 : -1}
                  className='eve-background-preset'
                  data-testid={`eve-background-preset-${background.id.replaceAll(':', '-')}`}
                  onClick={() => void selectBuiltinBackground(background.id)}
                  onKeyDown={(event) =>
                    moveRadioSelection(event, BUILTIN_BACKGROUND_IDS, selectedBuiltinBackgroundId, (next) => {
                      void selectBuiltinBackground(next);
                    })
                  }
                >
                  <img src={background.imageUrl} alt='' />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>

          {backgroundDataUrl ? (
            <div className='eve-background-editor'>
              <div className='eve-background-preview'>
                <img src={backgroundDataUrl} alt='' />
                <Tooltip content={t('settings.commandEveAppearance.removeBackground')}>
                  <button
                    type='button'
                    className='eve-background-preview__remove'
                    aria-label={t('settings.commandEveAppearance.removeBackground')}
                    onClick={confirmRemoveBackground}
                  >
                    <Delete size={16} />
                  </button>
                </Tooltip>
              </div>

              <label className='eve-appearance-toggle'>
                <span className='eve-appearance-toggle__title'>
                  {t('settings.commandEveAppearance.backgroundEnabled')}
                </span>
                <Switch
                  aria-label={t('settings.commandEveAppearance.backgroundEnabled')}
                  checked={visualPreferences.background.enabled}
                  onChange={(enabled) => updateBackground({ enabled })}
                />
              </label>

              <div
                className='eve-segmented-control'
                role='radiogroup'
                aria-label={t('settings.commandEveAppearance.fit')}
                aria-orientation='horizontal'
              >
                {FIT_OPTIONS.map((fit) => (
                  <button
                    key={fit}
                    type='button'
                    role='radio'
                    aria-checked={visualPreferences.background.fit === fit}
                    tabIndex={visualPreferences.background.fit === fit ? 0 : -1}
                    className='eve-segmented-control__option'
                    onClick={() => updateBackground({ fit })}
                    onKeyDown={(event) =>
                      moveRadioSelection(event, FIT_OPTIONS, visualPreferences.background.fit, (next) =>
                        updateBackground({ fit: next })
                      )
                    }
                  >
                    {t(`settings.commandEveAppearance.fit_${fit}`)}
                  </button>
                ))}
              </div>

              <label className='eve-appearance-toggle'>
                <span>
                  <span className='eve-appearance-toggle__title'>
                    {t('settings.commandEveAppearance.adaptiveTint')}
                  </span>
                  <span className='eve-appearance-toggle__description'>
                    {t('settings.commandEveAppearance.adaptiveTintDescription')}
                  </span>
                </span>
                <Switch
                  aria-label={t('settings.commandEveAppearance.adaptiveTint')}
                  checked={visualPreferences.background.adaptiveTint}
                  data-testid='eve-appearance-adaptive-tint'
                  onChange={(adaptiveTint) => updateBackground({ adaptiveTint })}
                />
              </label>

              <div className='eve-appearance-controls eve-appearance-controls--background'>
                <label className='eve-appearance-control'>
                  <span>{t('settings.commandEveAppearance.intensity')}</span>
                  <span className='eve-appearance-control__value'>{Math.round(backgroundIntensity * 100)}%</span>
                  <Slider
                    min={EVE_VISUAL_LIMITS.backgroundIntensity.min}
                    max={EVE_VISUAL_LIMITS.backgroundIntensity.max}
                    step={0.05}
                    value={backgroundIntensity}
                    onChange={(value) => setBackgroundIntensity(sliderNumber(value))}
                    onAfterChange={(value) => updateBackground({ intensity: sliderNumber(value) })}
                  />
                </label>
                <label className='eve-appearance-control'>
                  <span>{t('settings.commandEveAppearance.backgroundBlur')}</span>
                  <span className='eve-appearance-control__value'>{Math.round(backgroundBlur)} px</span>
                  <Slider
                    min={EVE_VISUAL_LIMITS.backgroundBlur.min}
                    max={EVE_VISUAL_LIMITS.backgroundBlur.max}
                    step={1}
                    value={backgroundBlur}
                    onChange={(value) => setBackgroundBlur(sliderNumber(value))}
                    onAfterChange={(value) => updateBackground({ blur: sliderNumber(value) })}
                  />
                </label>
                <label className='eve-appearance-control'>
                  <span>{t('settings.commandEveAppearance.dim')}</span>
                  <span className='eve-appearance-control__value'>{Math.round(backgroundDim * 100)}%</span>
                  <Slider
                    min={EVE_VISUAL_LIMITS.backgroundDim.min}
                    max={EVE_VISUAL_LIMITS.backgroundDim.max}
                    step={0.05}
                    value={backgroundDim}
                    onChange={(value) => setBackgroundDim(sliderNumber(value))}
                    onAfterChange={(value) => updateBackground({ dim: sliderNumber(value) })}
                  />
                </label>
              </div>
            </div>
          ) : (
            <button type='button' className='eve-background-empty' onClick={() => void uploadBackground()}>
              <UploadOne size={20} />
              <span>{t('settings.commandEveAppearance.chooseBackground')}</span>
            </button>
          )}
        </div>
      </section>
    </div>
  );
};

export default CommandEveAppearanceSettings;
