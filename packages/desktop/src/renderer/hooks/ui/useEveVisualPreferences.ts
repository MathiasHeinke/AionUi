/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { configService } from '@/common/config/configService';
import { LIGHT_THEME_ID } from '@/common/theme/constants';
import type { Theme } from '@/common/theme/types';
import { resolveActiveTheme } from '@/common/theme/resolveTheme';
import { BUILTIN_THEMES } from '@/renderer/theme/builtinThemes';
import {
  applyEveVisualPreferences,
  DEFAULT_EVE_VISUAL_PREFERENCES,
  normalizeEveVisualPreferences,
  resolveEveAppearance,
  type EveResolvedAppearance,
  type EveVisualPreferences,
} from '@/renderer/theme/visualPreferences';
import {
  garbageCollectEveVisualBackgrounds,
  resolveEveVisualBackground,
} from '@/renderer/theme/visualBackgroundAssets';

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
  const activeId = (configService.get('theme.activeId') as string) || LIGHT_THEME_ID;
  const userThemes = (configService.get('theme.userThemes') as Theme[]) ?? [];
  const legacyAppearance = resolveActiveTheme(activeId, [...BUILTIN_THEMES, ...userThemes]).appearance;
  return normalizeEveVisualPreferences({ ...DEFAULT_EVE_VISUAL_PREFERENCES, mode: legacyAppearance });
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
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const preferenceRevisionRef = useRef(0);
  const localNotificationRef = useRef<EveVisualPreferences | undefined>(undefined);
  const systemPrefersDark = useMediaMatch('(prefers-color-scheme: dark)');
  const reducedTransparency = useMediaMatch('(prefers-reduced-transparency: reduce)');
  const resolvedAppearance = resolveEveAppearance(preferences.mode, systemPrefersDark);
  const backgroundDataUrl = useMemo(
    () => resolveEveVisualBackground(preferences.background.assetId),
    [preferences.background.assetId]
  );

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
        preferenceRevisionRef.current += 1;
        preferencesRef.current = next;
        setPreferencesState(next);
        garbageCollectEveVisualBackgrounds(next.background.assetId);
        setLoaded(true);
      })
      .catch(() => {
        if (mounted) setLoaded(true);
      });

    const unsubscribe = configService.subscribe('commandEve.visualPreferences', (raw) => {
      if (!mounted || raw === undefined) return;
      const next = normalizeEveVisualPreferences(raw);
      if (raw !== localNotificationRef.current) preferenceRevisionRef.current += 1;
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
      backgroundDataUrl,
    });
  }, [backgroundDataUrl, enabled, preferences, reducedTransparency, resolvedAppearance]);

  const setPreferences = useCallback(async (updater: EveVisualPreferencesUpdater) => {
    const previous = preferencesRef.current;
    const candidate = typeof updater === 'function' ? updater(preferencesRef.current) : updater;
    const next = normalizeEveVisualPreferences(candidate);
    const revision = preferenceRevisionRef.current + 1;
    preferenceRevisionRef.current = revision;
    preferencesRef.current = next;
    setPreferencesState(next);

    const persistence = persistenceQueueRef.current.then(async () => {
      localNotificationRef.current = next;
      try {
        await configService.set('commandEve.visualPreferences', next);
      } finally {
        if (localNotificationRef.current === next) localNotificationRef.current = undefined;
      }
    });
    persistenceQueueRef.current = persistence.catch((): void => undefined);

    try {
      await persistence;
    } catch (error) {
      if (preferenceRevisionRef.current === revision) {
        preferenceRevisionRef.current += 1;
        preferencesRef.current = previous;
        setPreferencesState(previous);
        localNotificationRef.current = previous;
        configService.setLocal('commandEve.visualPreferences', previous);
        if (localNotificationRef.current === previous) localNotificationRef.current = undefined;
      }
      throw error;
    }
  }, []);

  return { preferences, resolvedAppearance, loaded, setPreferences };
};
