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
    light: { base: '#2563eb', rgb: '37, 99, 235', strong: '#1d4ed8' },
    dark: { base: '#2563eb', rgb: '37, 99, 235', strong: '#1e40af' },
  },
  petrol: {
    light: { base: '#0f766e', rgb: '15, 118, 110', strong: '#115e59' },
    dark: { base: '#0f766e', rgb: '15, 118, 110', strong: '#134e4a' },
  },
  emerald: {
    light: { base: '#15803d', rgb: '21, 128, 61', strong: '#166534' },
    dark: { base: '#15803d', rgb: '21, 128, 61', strong: '#14532d' },
  },
  graphite: {
    light: { base: '#475569', rgb: '71, 85, 105', strong: '#334155' },
    dark: { base: '#64748b', rgb: '100, 116, 139', strong: '#334155' },
  },
};

const APPEARANCE_MODES: EveAppearanceMode[] = ['system', 'light', 'dark'];
const ACCENTS: EveAccent[] = ['blue', 'petrol', 'emerald', 'graphite'];
const BACKGROUND_FITS: EveBackgroundFit[] = ['cover', 'contain', 'fill'];
const OPAQUE_ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const BACKGROUND_GLASS_OPACITY_FLOOR = 0.88;

type Rgb = readonly [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
const LIGHT_RAMP_MIXES = [
  [WHITE, 0.9],
  [WHITE, 0.76],
  [WHITE, 0.6],
  [WHITE, 0.4],
  [WHITE, 0.2],
  [WHITE, 0],
  [BLACK, 0.12],
  [BLACK, 0.26],
  [BLACK, 0.4],
  [BLACK, 0.54],
] as const;
const DARK_RAMP_MIXES = [
  [BLACK, 0.62],
  [BLACK, 0.48],
  [BLACK, 0.34],
  [BLACK, 0.22],
  [BLACK, 0.1],
  [BLACK, 0],
  [WHITE, 0.18],
  [WHITE, 0.36],
  [WHITE, 0.56],
  [WHITE, 0.76],
] as const;

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
  return OPAQUE_ASSET_ID.test(trimmed) ? trimmed : undefined;
};

const hexToRgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

const mixRgb = (base: Rgb, target: Rgb, targetWeight: number): Rgb => [
  Math.round(base[0] * (1 - targetWeight) + target[0] * targetWeight),
  Math.round(base[1] * (1 - targetWeight) + target[1] * targetWeight),
  Math.round(base[2] * (1 - targetWeight) + target[2] * targetWeight),
];

const rgbTriplet = (rgb: Rgb): string => rgb.join(', ');

const accentRamp = (accent: AccentTone, appearance: EveResolvedAppearance): string[] => {
  const base = hexToRgb(accent.base);
  const mixes = appearance === 'light' ? LIGHT_RAMP_MIXES : DARK_RAMP_MIXES;
  return mixes.map(([target, weight]) => rgbTriplet(mixRgb(base, target, weight)));
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
  const backgroundFloor = preferences.background.enabled ? BACKGROUND_GLASS_OPACITY_FLOOR : 0;
  const chromeOpacity = effectsDisabled ? 1 : Math.max(preferences.glassOpacity, backgroundFloor);
  const panelOpacity = Math.min(1, chromeOpacity + 0.06);
  const overlayOpacity = Math.min(1, chromeOpacity + 0.04);
  const chromeBlur = effectsDisabled ? 0 : preferences.glassBlur;
  const panelBlur = effectsDisabled ? 0 : Math.min(28, preferences.glassBlur * 0.6);
  const overlayBlur = effectsDisabled ? 0 : Math.min(28, preferences.glassBlur * 0.9);
  const accent = EVE_ACCENTS[preferences.accent][appearance];
  const ramp = accentRamp(accent, appearance);
  const lightAliases =
    appearance === 'light'
      ? ramp.slice(0, 4).map((value) => `rgb(${value})`)
      : [0.2, 0.35, 0.5, 0.65].map((opacity) => `rgba(${accent.rgb}, ${opacity})`);
  const primaryRamp = Object.fromEntries(ramp.map((value, index) => [`--primary-${index + 1}`, value]));

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
    ...primaryRamp,
    '--primary-rgb': accent.rgb,
    '--color-primary': accent.base,
    '--color-primary-6': accent.base,
    '--color-primary-light-1': lightAliases[0],
    '--color-primary-light-2': lightAliases[1],
    '--color-primary-light-3': lightAliases[2],
    '--color-primary-light-4': lightAliases[3],
    '--color-primary-dark-1': accent.strong,
  };
}
