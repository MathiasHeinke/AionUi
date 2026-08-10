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
const unifiedSendBarCss = readSource('packages/desktop/src/renderer/components/chat/UnifiedSendBar.css');
const guidInputSource = readSource('packages/desktop/src/renderer/pages/guid/components/GuidInputCard.tsx');
const speechSource = readSource('packages/desktop/src/renderer/components/chat/SpeechInputButton.tsx');
const speechCss = readSource('packages/desktop/src/renderer/components/chat/SpeechInputButton.css');
const workspaceCss = readSource(
  'packages/desktop/src/renderer/components/workspace/WorkspaceContextControl.module.css'
);
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
    expect(sendBoxSource).toContain("SquareSmall className='sendbox-stop-icon'");
    expect(sendBoxCss).toMatch(/\.sendbox-stop-icon\s*\{[\s\S]*?color:\s*#ffffff;/);
    expect(sendBoxCss).toContain('var(--eve-brand-logo, rgb(var(--primary-6)))');
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

  it('keeps a narrow workbench composer readable instead of compressing every control', () => {
    expect(sendBoxSource).toContain("data-testid='sendbox-surface'");
    expect(sendBoxSource).toContain('onClick={focusComposerInput}');
    expect(sendBoxSource).toContain("['eve-composer-container', className]");
    expect(sendBoxSource).toContain('aria-describedby={composerHintId}');
    expect(sendBoxSource).toContain('composer.closest<HTMLElement>(\'[id^="eve-chat-pane-"]\') ?? composer');
    expect(sendBoxSource).toContain('sendbox-composer-action-row');
    expect(sendBoxCss).toMatch(/@container eve-composer \(max-width: 400px\)/);
    expect(sendBoxCss).toMatch(/\.sendbox-composer-action-row > \.sendbox-actions[\s\S]*?gap:\s*4px !important/);
    expect(sendBoxCss).toMatch(
      /@container eve-composer \(max-width: 340px\)[\s\S]*?\.sendbox-composer-action-row[\s\S]*?flex-wrap:\s*nowrap !important/
    );
    expect(sendBoxCss).not.toMatch(
      /@container eve-composer \(max-width: 340px\)[\s\S]*?\.sendbox-composer-action-row[\s\S]*?grid-template-rows:\s*auto auto/
    );
    expect(sendBoxSource).toContain("data-testid='chat-file-drop-overlay'");
    expect(unifiedSendBarCss).toMatch(
      /\.eve-composer-container\s*\{[\s\S]*?container-name:\s*eve-composer;[\s\S]*?container-type:\s*inline-size;/
    );
    expect(unifiedSendBarCss).not.toMatch(/\.eve-composer-surface\s*\{[\s\S]*?container-name:\s*eve-composer;/);
    expect(guidInputSource).toContain("className='eve-composer-container w-full'");
    expect(guidInputSource).not.toContain('border-dashed guid-input-card-shell--dragging');
    expect(workspaceCss).toMatch(
      /@container eve-composer \(max-width: 400px\)[\s\S]*?\.controlLabel[\s\S]*?display:\s*none/
    );
  });
});
