/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type EveAppearanceMode = 'system' | 'light' | 'dark';
export type EveResolvedAppearance = Exclude<EveAppearanceMode, 'system'>;
export type EveAccent = 'blue' | 'petrol' | 'emerald' | 'graphite';
export type EveBackgroundFit = 'cover' | 'contain' | 'fill';

export type EveBackgroundPreferences = {
  enabled: boolean;
  assetId?: string;
  fit: EveBackgroundFit;
  intensity: number;
  blur: number;
  dim: number;
  adaptiveTint: boolean;
};

export type EveVisualPreferences = {
  schemaVersion: 1;
  mode: EveAppearanceMode;
  accent: EveAccent;
  glassOpacity: number;
  glassBlur: number;
  reducedEffects: boolean;
  background: EveBackgroundPreferences;
};

type AccentTone = {
  base: string;
  rgb: string;
  soft: string;
  hover: string;
  strong: string;
};

type AccentPair = {
  light: AccentTone;
  dark: AccentTone;
};

export const EVE_VISUAL_PREFERENCES_SCHEMA_VERSION = 1 as const;

export const EVE_VISUAL_LIMITS = {
  glassOpacity: { min: 0.72, max: 1 },
  glassBlur: { min: 0, max: 28 },
  backgroundIntensity: { min: 0.2, max: 1 },
  backgroundBlur: { min: 0, max: 24 },
  backgroundDim: { min: 0, max: 0.6 },
} as const;

export const DEFAULT_EVE_VISUAL_PREFERENCES: EveVisualPreferences = {
  schemaVersion: EVE_VISUAL_PREFERENCES_SCHEMA_VERSION,
  mode: 'system',
  accent: 'blue',
  glassOpacity: 0.84,
  glassBlur: 20,
  reducedEffects: false,
  background: {
    enabled: false,
    fit: 'cover',
    intensity: 1,
    blur: 0,
    dim: 0,
    adaptiveTint: true,
  },
};

export const EVE_ACCENTS: Record<EveAccent, AccentPair> = {
  blue: {
    light: { base: '#2563eb', rgb: '37, 99, 235', soft: '#dbeafe', hover: '#3b82f6', strong: '#1d4ed8' },
    dark: { base: '#2563eb', rgb: '37, 99, 235', soft: '#172554', hover: '#1d4ed8', strong: '#1e40af' },
  },
  petrol: {
    light: { base: '#0f766e', rgb: '15, 118, 110', soft: '#ccfbf1', hover: '#0d9488', strong: '#115e59' },
    dark: { base: '#0f766e', rgb: '15, 118, 110', soft: '#134e4a', hover: '#115e59', strong: '#134e4a' },
  },
  emerald: {
    light: { base: '#15803d', rgb: '21, 128, 61', soft: '#dcfce7', hover: '#16a34a', strong: '#166534' },
    dark: { base: '#15803d', rgb: '21, 128, 61', soft: '#14532d', hover: '#166534', strong: '#14532d' },
  },
  graphite: {
    light: { base: '#475569', rgb: '71, 85, 105', soft: '#e2e8f0', hover: '#64748b', strong: '#334155' },
    dark: { base: '#64748b', rgb: '100, 116, 139', soft: '#1e293b', hover: '#475569', strong: '#334155' },
  },
};

const APPEARANCE_MODES: EveAppearanceMode[] = ['system', 'light', 'dark'];
const ACCENTS: EveAccent[] = ['blue', 'petrol', 'emerald', 'graphite'];
const BACKGROUND_FITS: EveBackgroundFit[] = ['cover', 'contain', 'fill'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;

const finiteNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const normalizedAssetId = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 512) : undefined;
};

/**
 * Convert persisted or imported data into the bounded public Appearance model.
 * Unknown keys are dropped, malformed nested values fall back independently,
 * and accessibility ceilings are enforced at this first read boundary.
 */
export function normalizeEveVisualPreferences(input: unknown): EveVisualPreferences {
  const root = isRecord(input) ? input : {};
  const background = isRecord(root.background) ? root.background : {};
  const defaults = DEFAULT_EVE_VISUAL_PREFERENCES;

  return {
    schemaVersion: EVE_VISUAL_PREFERENCES_SCHEMA_VERSION,
    mode: isOneOf(root.mode, APPEARANCE_MODES, defaults.mode),
    accent: isOneOf(root.accent, ACCENTS, defaults.accent),
    glassOpacity: clamp(
      finiteNumber(root.glassOpacity, defaults.glassOpacity),
      EVE_VISUAL_LIMITS.glassOpacity.min,
      EVE_VISUAL_LIMITS.glassOpacity.max
    ),
    glassBlur: clamp(
      finiteNumber(root.glassBlur, defaults.glassBlur),
      EVE_VISUAL_LIMITS.glassBlur.min,
      EVE_VISUAL_LIMITS.glassBlur.max
    ),
    reducedEffects: typeof root.reducedEffects === 'boolean' ? root.reducedEffects : defaults.reducedEffects,
    background: {
      enabled: typeof background.enabled === 'boolean' ? background.enabled : defaults.background.enabled,
      assetId: normalizedAssetId(background.assetId),
      fit: isOneOf(background.fit, BACKGROUND_FITS, defaults.background.fit),
      intensity: clamp(
        finiteNumber(background.intensity, defaults.background.intensity),
        EVE_VISUAL_LIMITS.backgroundIntensity.min,
        EVE_VISUAL_LIMITS.backgroundIntensity.max
      ),
      blur: clamp(
        finiteNumber(background.blur, defaults.background.blur),
        EVE_VISUAL_LIMITS.backgroundBlur.min,
        EVE_VISUAL_LIMITS.backgroundBlur.max
      ),
      dim: clamp(
        finiteNumber(background.dim, defaults.background.dim),
        EVE_VISUAL_LIMITS.backgroundDim.min,
        EVE_VISUAL_LIMITS.backgroundDim.max
      ),
      adaptiveTint:
        typeof background.adaptiveTint === 'boolean' ? background.adaptiveTint : defaults.background.adaptiveTint,
    },
  };
}

const percentage = (value: number): string => `${Number((value * 100).toFixed(2))}%`;
const pixels = (value: number): string => `${Number(value.toFixed(2))}px`;

/**
 * Project validated preferences into the CSS custom properties consumed by the
 * Command EVE meta-theme. Reduced effects and background readability floors are
 * applied here, before the values reach the DOM.
 */
export function eveVisualCssVariables(
  input: unknown,
  appearance: EveResolvedAppearance,
  options: { reducedTransparency?: boolean } = {}
): Record<string, string> {
  const preferences = normalizeEveVisualPreferences(input);
  const effectsDisabled = preferences.reducedEffects || options.reducedTransparency === true;
  const backgroundFloor = preferences.background.enabled ? (appearance === 'dark' ? 0.82 : 0.88) : 0;
  const chromeOpacity = effectsDisabled ? 1 : Math.max(preferences.glassOpacity, backgroundFloor);
  const panelOpacity = Math.min(1, chromeOpacity + 0.06);
  const overlayOpacity = Math.min(1, chromeOpacity + 0.04);
  const chromeBlur = effectsDisabled ? 0 : preferences.glassBlur;
  const panelBlur = effectsDisabled ? 0 : Math.min(28, preferences.glassBlur * 0.6);
  const overlayBlur = effectsDisabled ? 0 : Math.min(28, preferences.glassBlur * 0.9);
  const accent = EVE_ACCENTS[preferences.accent][appearance];

  return {
    '--eve-glass-chrome-opacity': percentage(chromeOpacity),
    '--eve-glass-panel-opacity': percentage(panelOpacity),
    '--eve-glass-overlay-opacity': percentage(overlayOpacity),
    '--eve-glass-chrome-blur': pixels(chromeBlur),
    '--eve-glass-panel-blur': pixels(panelBlur),
    '--eve-glass-overlay-blur': pixels(overlayBlur),
    '--eve-bg-image-intensity': percentage(preferences.background.intensity),
    '--eve-bg-image-blur': pixels(preferences.background.blur),
    '--eve-bg-image-dim': percentage(preferences.background.dim),
    '--eve-accent': accent.base,
    '--primary': accent.base,
    '--primary-6': accent.rgb,
    '--primary-rgb': accent.rgb,
    '--color-primary': accent.base,
    '--color-primary-6': accent.base,
    '--color-primary-light-1': accent.soft,
    '--color-primary-light-2': accent.soft,
    '--color-primary-light-3': accent.hover,
    '--color-primary-dark-1': accent.strong,
  };
}
