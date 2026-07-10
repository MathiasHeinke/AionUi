/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { configService } from '@/common/config/configService';
import { DARK_THEME_ID } from '@/common/theme/constants';
import {
  applyEveVisualPreferences,
  DEFAULT_EVE_VISUAL_PREFERENCES,
  normalizeEveVisualPreferences,
  resolveEveAppearance,
  type EveResolvedAppearance,
  type EveVisualPreferences,
} from '@/renderer/theme/visualPreferences';
import { resolveEveVisualBackground } from '@/renderer/theme/visualBackgroundAssets';

export type EveVisualPreferencesUpdater =
  | EveVisualPreferences
  | ((current: EveVisualPreferences) => EveVisualPreferences);

type EveVisualPreferencesState = {
  preferences: EveVisualPreferences;
  resolvedAppearance: EveResolvedAppearance;
  loaded: boolean;
  setPreferences: (updater: EveVisualPreferencesUpdater) => Promise<void>;
};

const mediaMatches = (query: string): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;

const legacyAppearancePreferences = (): EveVisualPreferences => {
  const legacyMode = configService.get('theme.activeId') === DARK_THEME_ID ? 'dark' : 'light';
  return normalizeEveVisualPreferences({ ...DEFAULT_EVE_VISUAL_PREFERENCES, mode: legacyMode });
};

const useMediaMatch = (query: string): boolean => {
  const [matches, setMatches] = useState(() => mediaMatches(query));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
};

export const useEveVisualPreferences = (enabled: boolean): EveVisualPreferencesState => {
  const [preferences, setPreferencesState] = useState(DEFAULT_EVE_VISUAL_PREFERENCES);
  const [loaded, setLoaded] = useState(!enabled);
  const preferencesRef = useRef(preferences);
  const systemPrefersDark = useMediaMatch('(prefers-color-scheme: dark)');
  const reducedTransparency = useMediaMatch('(prefers-reduced-transparency: reduce)');
  const resolvedAppearance = resolveEveAppearance(preferences.mode, systemPrefersDark);

  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    if (!enabled) return;
    let mounted = true;

    void configService
      .whenReady()
      .then(() => {
        if (!mounted) return;
        const raw = configService.get('commandEve.visualPreferences');
        const next = raw === undefined ? legacyAppearancePreferences() : normalizeEveVisualPreferences(raw);
        preferencesRef.current = next;
        setPreferencesState(next);
        setLoaded(true);
      })
      .catch(() => {
        if (mounted) setLoaded(true);
      });

    const unsubscribe = configService.subscribe('commandEve.visualPreferences', (raw) => {
      if (!mounted || raw === undefined) return;
      const next = normalizeEveVisualPreferences(raw);
      preferencesRef.current = next;
      setPreferencesState(next);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    applyEveVisualPreferences(preferences, resolvedAppearance, {
      reducedTransparency,
      backgroundDataUrl: resolveEveVisualBackground(preferences.background.assetId),
    });
  }, [enabled, preferences, reducedTransparency, resolvedAppearance]);

  const setPreferences = useCallback(async (updater: EveVisualPreferencesUpdater) => {
    const candidate = typeof updater === 'function' ? updater(preferencesRef.current) : updater;
    const next = normalizeEveVisualPreferences(candidate);
    preferencesRef.current = next;
    setPreferencesState(next);
    await configService.set('commandEve.visualPreferences', next);
  }, []);

  return { preferences, resolvedAppearance, loaded, setPreferences };
};
