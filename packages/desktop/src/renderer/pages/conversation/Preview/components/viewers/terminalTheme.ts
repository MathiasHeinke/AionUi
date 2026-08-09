export type TerminalColorScheme = 'light' | 'dark';

export type CommandEveTerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  black: string;
  brightBlack: string;
  blue: string;
  brightBlue: string;
  cyan: string;
  brightCyan: string;
  green: string;
  brightGreen: string;
  magenta: string;
  brightMagenta: string;
  red: string;
  brightRed: string;
  white: string;
  brightWhite: string;
  yellow: string;
  brightYellow: string;
};

const resolveThemeToken = (name: string, fallback: string): string => {
  if (typeof document === 'undefined') return fallback;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^(?:#|rgb\(|rgba\(|hsl\(|hsla\(|oklch\(|color\()/.test(value) ? value : fallback;
};

/**
 * Xterm draws its own canvas, so it needs real colors rather than inherited CSS.
 * The canvas itself stays transparent and lets the EVE workbench surface carry
 * the visual treatment; ANSI colors remain contrast-safe in both shell themes.
 */
export const resolveTerminalTheme = (mode: TerminalColorScheme): CommandEveTerminalTheme => {
  const dark = mode === 'dark';
  const foreground = resolveThemeToken('--eve-shell-text', dark ? '#f4f7fb' : '#18202d');
  const accent = resolveThemeToken('--color-primary-6', dark ? '#79aaff' : '#1559c2');
  const transparent = 'rgba(0, 0, 0, 0)';

  return {
    background: transparent,
    foreground,
    cursor: accent,
    cursorAccent: transparent,
    selectionBackground: dark ? '#4f85e34d' : '#1559c229',
    selectionInactiveBackground: dark ? '#4f85e329' : '#1559c218',
    black: dark ? '#1f2735' : '#18202d',
    brightBlack: dark ? '#748095' : '#596579',
    blue: dark ? '#79aaff' : '#1559c2',
    brightBlue: dark ? '#9dc2ff' : '#174ea6',
    cyan: dark ? '#6ed4da' : '#0b7180',
    brightCyan: dark ? '#9be7ea' : '#075f6d',
    green: dark ? '#75d9a8' : '#14754e',
    brightGreen: dark ? '#9ce9c1' : '#0f6642',
    magenta: dark ? '#bea2ff' : '#7448ad',
    brightMagenta: dark ? '#d6c5ff' : '#623992',
    red: dark ? '#ff818d' : '#b83246',
    brightRed: dark ? '#ffa5ad' : '#9e273a',
    white: dark ? '#dce4f0' : '#4f5b6e',
    brightWhite: dark ? '#f7f9fc' : '#18202d',
    yellow: dark ? '#e9ca70' : '#795900',
    brightYellow: dark ? '#f5dc96' : '#664b00',
  };
};
