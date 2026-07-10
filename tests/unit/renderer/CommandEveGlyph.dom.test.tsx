/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import CommandEveGlyph from '@/renderer/components/commandEve/CommandEveGlyph';

afterEach(cleanup);

describe('CommandEveGlyph', () => {
  it('renders the transparent EVE identity as decorative by default', () => {
    render(<CommandEveGlyph />);

    const glyph = screen.getByTestId('command-eve-glyph');
    expect(glyph.textContent).toBe('⌘');
    expect(glyph.getAttribute('aria-hidden')).toBe('true');
    expect(glyph.querySelector('img')).toBeNull();
  });

  it('accepts bounded presentation overrides without adding a tile', () => {
    render(<CommandEveGlyph size={16} className='command-eve-glyph--muted' decorative={false} />);

    const glyph = screen.getByTestId('command-eve-glyph');
    expect(glyph.style.fontSize).toBe('16px');
    expect(glyph.classList.contains('command-eve-glyph--muted')).toBe(true);
    expect(glyph.hasAttribute('aria-hidden')).toBe(false);
  });
});
