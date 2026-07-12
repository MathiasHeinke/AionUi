/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const readSource = (relativePath: string): string => readFileSync(resolve(process.cwd(), relativePath), 'utf8');

const sendBoxSource = readSource('packages/desktop/src/renderer/components/chat/SendBox/index.tsx');
const sendBoxCss = readSource('packages/desktop/src/renderer/components/chat/SendBox/sendbox.css');
const speechSource = readSource('packages/desktop/src/renderer/components/chat/SpeechInputButton.tsx');
const speechCss = readSource('packages/desktop/src/renderer/components/chat/SpeechInputButton.css');
const visualThemeCss = readSource('packages/desktop/src/renderer/styles/themes/command-eve-visual.css');

describe('EVE composer surface contract', () => {
  it('loads speech states from the reusable speech component boundary', () => {
    expect(speechSource).toContain("import './SpeechInputButton.css';");
    expect(speechCss).toContain('.speech-input-button--listening');
    expect(speechCss).toContain('.speech-input-button--processing');
    expect(speechCss).toContain('color: var(--color-text-3) !important;');
    expect(speechCss).toMatch(/\.speech-input-button > \.arco-btn[\s\S]*?color:\s*inherit !important;/);
    expect(sendBoxCss).not.toContain('.speech-input-');
  });

  it('keeps drag feedback, stop contrast and scoped placeholders intact', () => {
    expect(sendBoxSource).toContain("isFileDragging ? 'eve-composer-surface--dragging' : ''");
    expect(sendBoxSource).toContain("className='sendbox-stop-icon'");
    expect(sendBoxCss).toMatch(/\.sendbox-stop-icon\s*\{[\s\S]*?background:\s*#ffffff;/);
    expect(sendBoxCss).toContain('.sendbox-panel ::placeholder');
    expect(sendBoxCss).not.toMatch(/(?:^|\n)::placeholder\s*\{/);
  });

  it('provides solid composer fallbacks when blur is unavailable or reduced', () => {
    expect(visualThemeCss).toMatch(
      /@supports not[\s\S]*?\.eve-composer-surface\s*\{[\s\S]*?background:\s*var\(--glass-composer-bg-solid\) !important;/
    );
    expect(visualThemeCss).toMatch(
      /prefers-reduced-transparency:[\s\S]*?\.eve-composer-surface\s*\{[\s\S]*?background:\s*var\(--glass-composer-bg-solid\) !important;/
    );
  });
});
