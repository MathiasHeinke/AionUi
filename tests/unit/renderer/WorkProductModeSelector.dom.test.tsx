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

const modes: readonly LocalizedComposerWorkProductModeDescriptor[] = [
  { mode: 'image', label: 'Bild erstellen', tooltip: 'Bildmodus auswählen' },
  { mode: 'video', label: 'Video erstellen', tooltip: 'Videomodus auswählen' },
  { mode: 'presentation', label: 'Präsentation erstellen', tooltip: 'Präsentationsmodus auswählen' },
  { mode: 'pdf', label: 'PDF erstellen', tooltip: 'PDF-Modus auswählen' },
];

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
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
