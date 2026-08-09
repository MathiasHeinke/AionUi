/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest';

import { resolveTerminalTheme } from '@/renderer/pages/conversation/Preview/components/viewers/terminalTheme';

describe('Command EVE terminal theme', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--eve-shell-text');
    document.documentElement.style.removeProperty('--color-primary-6');
  });

  it('keeps the xterm canvas transparent so the workbench surface remains continuous', () => {
    const light = resolveTerminalTheme('light');
    const dark = resolveTerminalTheme('dark');

    expect(light.background).toBe('rgba(0, 0, 0, 0)');
    expect(light.cursorAccent).toBe('rgba(0, 0, 0, 0)');
    expect(dark.background).toBe('rgba(0, 0, 0, 0)');
    expect(dark.cursorAccent).toBe('rgba(0, 0, 0, 0)');
  });

  it('uses EVE shell tokens for foreground and focus while retaining readable light ANSI colors', () => {
    document.documentElement.style.setProperty('--eve-shell-text', 'rgb(24, 32, 45)');
    document.documentElement.style.setProperty('--color-primary-6', 'rgb(21, 89, 194)');

    const theme = resolveTerminalTheme('light');

    expect(theme.foreground).toBe('rgb(24, 32, 45)');
    expect(theme.cursor).toBe('rgb(21, 89, 194)');
    expect(theme.brightBlue).toBe('#174ea6');
    expect(theme.brightCyan).toBe('#075f6d');
    expect(theme.brightYellow).toBe('#664b00');
  });
});
