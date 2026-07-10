/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// context/ThemeContext.tsx - Unified Theme Management Context 统一主题管理上下文
import type { PropsWithChildren } from 'react';
import React, { createContext, useCallback, useContext } from 'react';
import type { Theme, ThemeAppearance } from '@/common/theme/types';
import useTheme from '@renderer/hooks/system/useTheme';
import { LIGHT_THEME_ID, DARK_THEME_ID } from '@/common/theme/constants';
import useFontScale from '@renderer/hooks/ui/useFontScale';
import useFontSizes from '@renderer/hooks/ui/useFontSizes';
import type { FontSizeKey, FontSizes } from '@/common/config/fontSizes';
import { COMMAND_EVE_SHELL_ENABLED } from '@/common/config/commandEveShell';
import { useEveVisualPreferences, type EveVisualPreferencesUpdater } from '@renderer/hooks/ui/useEveVisualPreferences';
import type { EveVisualPreferences } from '@renderer/theme/visualPreferences';

interface ThemeContextValue {
  // Light/Dark appearance of the active theme (back-compat for existing consumers)
  theme: ThemeAppearance;
  // Back-compat light/dark toggle → selects the Light or Dark built-in theme
  setTheme: (appearance: ThemeAppearance) => Promise<void>;
  // The full unified active theme + selector by id (used by the new gallery)
  activeTheme: Theme | null;
  selectTheme: (id: string) => Promise<void>;
  // Font scaling (unchanged)
  fontScale: number;
  setFontScale: (scale: number) => Promise<void>;
  // Per-region font sizes (px)
  fontSizes: FontSizes;
  setFontSize: (key: FontSizeKey, px: number) => Promise<void>;
  visualPreferences: EveVisualPreferences;
  setVisualPreferences: (updater: EveVisualPreferencesUpdater) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export const ThemeProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const [activeTheme, selectTheme] = useTheme();
  const [fontScale, setFontScale] = useFontScale();
  const { fontSizes, setFontSize } = useFontSizes();
  const {
    preferences: visualPreferences,
    resolvedAppearance,
    loaded,
    setPreferences: setVisualPreferences,
  } = useEveVisualPreferences(COMMAND_EVE_SHELL_ENABLED);
  const theme: ThemeAppearance = COMMAND_EVE_SHELL_ENABLED ? resolvedAppearance : (activeTheme?.appearance ?? 'light');
  const setTheme = useCallback(
    (appearance: ThemeAppearance) =>
      COMMAND_EVE_SHELL_ENABLED
        ? setVisualPreferences((current) => ({ ...current, mode: appearance }))
        : selectTheme(appearance === 'dark' ? DARK_THEME_ID : LIGHT_THEME_ID),
    [selectTheme, setVisualPreferences]
  );

  React.useEffect(() => {
    if (!COMMAND_EVE_SHELL_ENABLED || !loaded || !activeTheme) return;
    const targetId = resolvedAppearance === 'dark' ? DARK_THEME_ID : LIGHT_THEME_ID;
    if (activeTheme.id !== targetId) void selectTheme(targetId);
  }, [activeTheme, loaded, resolvedAppearance, selectTheme]);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme,
        activeTheme,
        selectTheme,
        fontScale,
        setFontScale,
        fontSizes,
        setFontSize,
        visualPreferences,
        setVisualPreferences,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

export const useThemeContext = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useThemeContext must be used within ThemeProvider');
  }
  return context;
};
