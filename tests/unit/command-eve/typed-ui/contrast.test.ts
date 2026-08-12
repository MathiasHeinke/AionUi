/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as Rgb;
};
const luminance = (color: Rgb): number => {
  const linear = color.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
const contrast = (a: string, b: string): number => {
  const values = [luminance(rgb(a)), luminance(rgb(b))].toSorted((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
};
const mix = (foreground: string, background: string, share: number): string => {
  const fg = rgb(foreground);
  const bg = rgb(background);
  return `#${fg
    .map((value, index) =>
      Math.round(value * share + bg[index] * (1 - share))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
};

describe('Typed UI AAA text-token gate', () => {
  it.each([
    ['light', '#111827', '#ffffff'],
    ['dark', '#f7f8fa', '#171a1e'],
  ])('%s primary and secondary text are at least 7:1 against the solid surface', (_theme, text, surface) => {
    expect(contrast(text, surface)).toBeGreaterThanOrEqual(7);
    expect(contrast(mix(text, surface, 0.82), surface)).toBeGreaterThanOrEqual(7);
  });

  it('binds the renderer to the shipped semantic light/dark tokens and visible focus ring', () => {
    const theme = fs.readFileSync(
      path.resolve(process.cwd(), 'packages/desktop/src/renderer/styles/themes/command-eve-visual.css'),
      'utf8'
    );
    const component = fs.readFileSync(
      path.resolve(
        process.cwd(),
        'packages/desktop/src/renderer/pages/conversation/Messages/components/TypedGenerativeUI/TypedGenerativeUI.module.css'
      ),
      'utf8'
    );
    for (const token of [
      '--eve-shell-text: #111827',
      '--eve-shell-surface: #ffffff',
      '--eve-shell-text: #f7f8fa',
      '--eve-shell-surface: #171a1e',
    ]) {
      expect(theme).toContain(token);
    }
    expect(component).toContain('var(--eve-shell-text');
    expect(component).toContain('var(--eve-shell-surface');
    expect(component).toContain('--typed-ui-text-secondary: color-mix(');
    expect(component).toContain('var(--eve-shell-text, var(--color-text-1)) 82%');
    expect(component).toContain(':focus-visible');
    expect(component).toContain('outline: 2px solid var(--eve-focus-ring');
    expect(component).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
