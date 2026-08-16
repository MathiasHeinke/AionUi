/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ComposerWorkProductMode,
  LocalizedComposerWorkProductActionDescriptor,
  LocalizedComposerWorkProductModeDescriptor,
} from '@/common/config/composerWorkProductModeCore';
import WorkProductModeSelector, { WorkProductModeHeader } from '@/renderer/components/chat/WorkProductModeSelector';

const readCssBlock = (source: string, anchor: string): string => {
  const start = source.indexOf(anchor);
  expect(start, `missing CSS contract anchor: ${anchor}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  expect(open, `missing opening brace after: ${anchor}`).toBeGreaterThan(start);

  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }

  throw new Error(`unterminated CSS block: ${anchor}`);
};

const cssWithoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '');

const modes: readonly LocalizedComposerWorkProductModeDescriptor[] = [
  { mode: 'image', label: 'Bild erstellen', tooltip: 'Bildmodus auswählen' },
  { mode: 'video', label: 'Video erstellen', tooltip: 'Videomodus auswählen' },
  { mode: 'presentation', label: 'Präsentation erstellen', tooltip: 'Präsentationsmodus auswählen' },
  { mode: 'pdf', label: 'PDF erstellen', tooltip: 'PDF-Modus auswählen' },
  { mode: 'word', label: 'Word erstellen', tooltip: 'Word-Modus auswählen' },
  { mode: 'excel', label: 'Excel erstellen', tooltip: 'Excel-Modus auswählen' },
];

const readSelectorCss = (): string =>
  cssWithoutComments(
    fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../packages/desktop/src/renderer/components/chat/WorkProductModeSelector.module.css'
      ),
      'utf8'
    )
  );

const readModeAccents = (rootAnchor: string): readonly (string | undefined)[] => {
  const root = readCssBlock(readSelectorCss(), rootAnchor);
  return modes.map(({ mode }) =>
    root.match(new RegExp(`--eve-work-product-${mode}-accent:\\s*(#[0-9a-f]{6});`, 'i'))?.[1].toLowerCase()
  );
};

const actions: LocalizedComposerWorkProductActionDescriptor = {
  toolbarLabel: 'Werkzeuge und Arbeitsprodukte',
  returnToChatLabel: 'Zurück zum Chat',
  selectedReferenceLabel: 'Ausgewählte Referenz',
  removeReferenceLabel: 'Referenz entfernen',
};

afterEach(cleanup);

const Harness: React.FC = () => {
  const [mode, setMode] = useState<ComposerWorkProductMode>('chat');
  return (
    <>
      <WorkProductModeSelector value={mode} onChange={setMode} modes={modes} actions={actions} />
      <WorkProductModeHeader value={mode} onChange={setMode} modes={modes} actions={actions} />
    </>
  );
};

describe('WorkProductModeSelector', () => {
  it('keeps one tools trigger and grants a mode only after an explicit menu click', async () => {
    render(<Harness />);
    expect(screen.queryByText('Bild erstellen')).toBeNull();

    fireEvent.click(screen.getByTestId('work-product-tools-trigger'));
    fireEvent.click(await screen.findByTestId('work-product-mode-image'));

    expect(await screen.findByTestId('work-product-mode-header')).toBeVisible();
    expect(screen.getByTestId('work-product-active-image')).toHaveTextContent('Bild erstellen');
    expect(screen.getByTestId('work-product-tools-trigger')).toHaveAttribute('data-mode', 'image');
  });

  it('exposes one labeled menu launcher instead of a permanent icon strip', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: actions.toolbarLabel });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(screen.getAllByTestId('work-product-tools-trigger')).toHaveLength(1);
    expect(screen.queryByTestId('work-product-mode-toolbar')).toBeNull();
  });

  it('returns the active header to ordinary chat on click', () => {
    const onChange = vi.fn();
    render(<WorkProductModeHeader value='video' onChange={onChange} modes={modes} actions={actions} />);
    fireEvent.click(screen.getByRole('button', { name: actions.returnToChatLabel }));
    expect(onChange).toHaveBeenCalledWith('chat');
  });

  it('shows the selected reference at the far edge and removes it explicitly', () => {
    const onRemoveReference = vi.fn();
    render(
      <WorkProductModeHeader
        value='image'
        onChange={vi.fn()}
        modes={modes}
        actions={actions}
        selectedReference={{ title: 'Kampagnenmotiv 03', kind: 'image', kindLabel: 'Bild' }}
        onRemoveReference={onRemoveReference}
      />
    );

    expect(screen.getByTestId('work-product-reference-chip')).toHaveAttribute('data-kind', 'image');
    expect(screen.getByText('Kampagnenmotiv 03')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: actions.removeReferenceLabel }));
    expect(onRemoveReference).toHaveBeenCalledTimes(1);
  });

  it('renders a real reference thumbnail and the compact reference label in the header edge', () => {
    render(
      <WorkProductModeHeader
        value='image'
        onChange={vi.fn()}
        modes={modes}
        actions={actions}
        selectedReference={{
          title: 'campaign-reference.png',
          kind: 'image',
          kindLabel: 'Referenzbild',
          preview: <img src='data:image/png;base64,AA==' alt='' />,
        }}
        onRemoveReference={vi.fn()}
      />
    );

    expect(screen.getByTestId('work-product-reference-chip')).toHaveTextContent('Referenzbild');
    expect(screen.queryByText('campaign-reference.png')).toBeNull();
    expect(document.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,AA==');
  });

  it('drops duplicate or unlabeled runtime descriptors instead of exposing broken menu entries', async () => {
    const malformed = [
      modes[0],
      modes[0],
      { mode: 'video', label: '', tooltip: '' },
    ] as readonly LocalizedComposerWorkProductModeDescriptor[];
    render(<WorkProductModeSelector value='chat' onChange={vi.fn()} modes={malformed} actions={actions} />);

    fireEvent.click(screen.getByTestId('work-product-tools-trigger'));
    expect(await screen.findAllByTestId('work-product-mode-image')).toHaveLength(1);
    expect(screen.queryByTestId('work-product-mode-video')).toBeNull();
  });

  it('wires the semantic mode identity to every menu icon, the selected marker and the active header pill', async () => {
    render(<WorkProductModeSelector value='pdf' onChange={vi.fn()} modes={modes} actions={actions} />);

    fireEvent.click(screen.getByTestId('work-product-tools-trigger'));
    await screen.findByTestId('work-product-mode-image');
    for (const descriptor of modes) {
      const item = screen.getByTestId(`work-product-mode-${descriptor.mode}`);
      const modeNodes = item.querySelectorAll(`[data-mode='${descriptor.mode}']`);
      expect(modeNodes.length, `${descriptor.mode} menu icon lost data-mode`).toBeGreaterThanOrEqual(1);
    }

    const selectedPdfNodes = screen
      .getByTestId('work-product-mode-pdf')
      .querySelectorAll("[data-mode='pdf'][aria-hidden='true']");
    expect(selectedPdfNodes).toHaveLength(2);

    cleanup();
    const { rerender } = render(
      <WorkProductModeHeader value='image' onChange={vi.fn()} modes={modes} actions={actions} />
    );
    for (const descriptor of modes) {
      rerender(<WorkProductModeHeader value={descriptor.mode} onChange={vi.fn()} modes={modes} actions={actions} />);
      expect(screen.getByTestId(`work-product-active-${descriptor.mode}`)).toHaveAttribute(
        'data-mode',
        descriptor.mode
      );
    }
  });

  it('keeps tool affordances flat and bound to the semantic accent of each mode', () => {
    const css = readSelectorCss();

    for (const anchor of [
      ".trigger:global(.arco-btn)[data-active='true'] {",
      '.menuIcon {',
      '.activeMode:global(.arco-btn) {',
    ]) {
      expect(readCssBlock(css, anchor), `${anchor} must stay flat`).not.toMatch(/gradient\(/i);
    }

    for (const { mode } of modes) {
      const identityDeclarations = readCssBlock(css, `.trigger[data-mode='${mode}'],`);
      const surfaceDeclarations = readCssBlock(
        css,
        `:global(.eve-composer-surface):has(.activeMode[data-mode='${mode}']) {`
      );
      expect(identityDeclarations).toContain(`var(--eve-work-product-${mode}-accent)`);
      expect(surfaceDeclarations).toContain(`var(--eve-work-product-${mode}-accent)`);
    }
  });

  // Light and dark are asserted separately: a theme that loses its accents must
  // fail on its own instead of hiding behind the other one.
  it('gives every tool mode a distinct accent in light mode', () => {
    const accents = readModeAccents(':global(:root) {');

    expect(accents.every(Boolean)).toBe(true);
    expect(new Set(accents)).toHaveLength(modes.length);
  });

  it('gives every tool mode a distinct accent in dark mode, retuned away from light', () => {
    const lightAccents = readModeAccents(':global(:root) {');
    const darkAccents = readModeAccents(":global(:root[data-theme='dark']) {");

    expect(darkAccents.every(Boolean)).toBe(true);
    expect(new Set(darkAccents)).toHaveLength(modes.length);
    expect(darkAccents).not.toEqual(lightAccents);
  });

  it('tints only the existing composer hairline for the selected tool', () => {
    const css = cssWithoutComments(
      fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../packages/desktop/src/renderer/components/chat/WorkProductModeSelector.module.css'
        ),
        'utf8'
      )
    );
    const surfaceDeclarations = readCssBlock(css, ':global(.eve-composer-surface):has(.activeMode[data-mode]) {');

    expect(surfaceDeclarations).toContain('--eve-spotlight-color: var(--eve-work-product-surface-accent)');
    expect(surfaceDeclarations).toContain('border-color: var(--eve-composer-border) !important');
    expect(surfaceDeclarations).toContain('42%');
    expect(surfaceDeclarations).not.toMatch(/(^|[;\n])\s*(?:border-width|border|box-shadow)\s*:/i);
  });

  it('keeps focus and shell selection on the system blue lane', () => {
    const css = cssWithoutComments(
      fs.readFileSync(
        path.resolve(
          __dirname,
          '../../../packages/desktop/src/renderer/components/chat/WorkProductModeSelector.module.css'
        ),
        'utf8'
      )
    );
    const visualCss = cssWithoutComments(
      fs.readFileSync(
        path.resolve(__dirname, '../../../packages/desktop/src/renderer/styles/themes/command-eve-visual.css'),
        'utf8'
      )
    );
    const focusDeclarations = readCssBlock(css, '.trigger:global(.arco-btn):focus-visible,');

    expect(focusDeclarations).toContain('var(--eve-focus-ring)');
    expect(focusDeclarations).not.toContain('--work-product-accent');
    expect(visualCss).toMatch(/--eve-interaction-selected-indicator:\s*var\(--eve-accent\);/);
    expect(visualCss).toMatch(/--eve-accent:\s*var\(--primary\);/);
    expect(visualCss).toMatch(/--eve-focus-ring:\s*var\(--color-primary-6,\s*var\(--primary\)\);/);
  });

  it('uses native tokens, responsive overflow and reduced-motion fallbacks', () => {
    const css = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../packages/desktop/src/renderer/components/chat/WorkProductModeSelector.module.css'
      ),
      'utf8'
    );

    expect(css).toContain('overflow-x: auto');
    expect(css).toContain('@media (max-width: 640px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(/var\(--eve-brand-logo|var\(--glass-composer-bg|var\(--eve-focus-ring/);
    expect(css.match(/#[0-9a-f]{6}\b/gi)).toHaveLength(modes.length * 2);
  });
});
