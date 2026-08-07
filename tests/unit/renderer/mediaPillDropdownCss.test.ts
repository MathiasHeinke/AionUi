/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The media-model dropdown speaks EVE glass — CONSUMPTION-verified (CEVE-18205).
 *
 * Founder finding on the real screen: the dropdown floated over the dark glass
 * composer as a bright foreign panel, because billing.css consumed exactly ONE
 * EVE token (--eve-max-accent) and otherwise ran on foreign fallbacks
 * (--bg-2/#fff, --border-secondary, --text-tertiary, a hard rgba shadow).
 *
 * Like the glow suite's consumption guard: this asserts that each rule READS
 * the tokens (var(--…) in the rule body), never that tokens merely exist
 * somewhere — and it bans the foreign vocabulary from the dropdown section so
 * it cannot creep back one declaration at a time.
 *
 * PARITY IS PART OF THE CONTRACT: ImageModelPill renders through the same
 * MediaModelDropdown/MediaPillDropdown and the same video-quality-pill__*
 * classes, so image and video menus are one surface by construction. The
 * source contract below keeps that true.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string): string => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const billingCss = read('packages/desktop/src/renderer/components/billing/billing.css');
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '');
const css = stripComments(billingCss);

/** The dropdown section: from the shared-dropdown wrapper to the reduced-motion block. */
function dropdownSection(): string {
  const start = css.indexOf('.video-quality-pill__model-dropdown {');
  expect(start, 'the dropdown section moved — re-anchor this suite').toBeGreaterThan(-1);
  const end = css.indexOf('@media (prefers-reduced-motion: reduce)', start);
  return end === -1 ? css.slice(start) : css.slice(start, end);
}

/** The body of the first rule whose selector list ENDS with this selector. */
function ruleBody(selector: string): string {
  const index = css.indexOf(`${selector} {`);
  expect(index, `selector not found: ${selector}`).toBeGreaterThan(-1);
  const open = css.indexOf('{', index);
  return css.slice(open + 1, css.indexOf('}', open));
}

describe('dropdown rules CONSUME the EVE glass tokens (not merely coexist with them)', () => {
  const CONSUMPTION: Array<[string, string[]]> = [
    [
      '.video-quality-pill__model-list',
      [
        'var(--glass-overlay-bg)',
        'var(--glass-overlay-border)',
        'var(--glass-overlay-filter)',
        'var(--glass-shadow-soft)',
        'var(--glass-edge-highlight)',
        'var(--eve-shell-text)',
      ],
    ],
    ['.video-quality-pill__section-label', ['var(--eve-shell-text-secondary)']],
    ['.video-quality-pill__divider', ['var(--glass-overlay-border)']],
    ['.video-quality-pill__model-trigger', ['var(--eve-composer-border)']],
    [
      '.video-quality-pill__model-entry:hover:not(:disabled)',
      ['var(--glass-overlay-border)', 'var(--eve-row-hover-bg)'],
    ],
    ['.video-quality-pill__model-entry:focus-visible', ['var(--eve-focus-ring)']],
    [
      '.video-quality-pill__chip',
      ['var(--eve-static-white)', 'var(--eve-shell-text-secondary)', 'var(--glass-overlay-border)'],
    ],
    ['.video-quality-pill__model-price', ['var(--eve-shell-text)', 'var(--eve-shell-text-secondary)']],
    ['.video-quality-pill__model-show-more', ['var(--glass-overlay-border)', 'var(--eve-accent']],
    ['.video-quality-pill__model-note', ['var(--glass-overlay-border)', 'var(--eve-shell-text-secondary)']],
  ];

  it.each(CONSUMPTION)('%s reads its EVE tokens', (selector, tokens) => {
    const body = ruleBody(selector);
    for (const token of tokens) {
      expect(body.includes(token), `${selector} no longer reads ${token} — the foreign-panel look is back`).toBe(true);
    }
  });

  it('the overlay filter is consumed on BOTH engines (webkit prefix included)', () => {
    const body = ruleBody('.video-quality-pill__model-list');
    expect(body).toMatch(/-webkit-backdrop-filter:\s*var\(--glass-overlay-filter\)/);
    expect(body).toMatch(/(?<!-webkit-)backdrop-filter:\s*var\(--glass-overlay-filter\)/);
  });
});

describe('the foreign vocabulary is BANNED from the dropdown section', () => {
  const section = dropdownSection;

  it('no foreign tokens and no hard rgba shadow anywhere in the section', () => {
    for (const foreign of ['--bg-2', '--color-bg-2', '--border-secondary', '--text-tertiary', 'rgba(0, 0, 0']) {
      expect(section().includes(foreign), `foreign token back in the dropdown section: ${foreign}`).toBe(false);
    }
  });

  it('hex literals survive ONLY as provider brand identity on the chips', () => {
    for (const rule of section().matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (rule[1].includes('[data-provider=')) continue; // brand colours, literal on purpose
      expect(
        /#[0-9a-fA-F]{3,8}\b/.test(rule[2]),
        `hex literal outside the provider chips: ${rule[1].trim().split('\n').pop()}`
      ).toBe(false);
    }
  });
});

describe('content-wide geometry (the ellipsis-with-free-space fix)', () => {
  it('the list is content-wide in CSS; floors and caps arrive via the placement style', () => {
    const body = ruleBody('.video-quality-pill__model-list');
    expect(body).toMatch(/width:\s*max-content/);
    // The old static clamp pair is gone — minWidth/maxWidth are computed per
    // open from trigger + viewport (pillDropdownPlacement) and applied inline.
    expect(body).not.toMatch(/min-width:/);
    expect(body).not.toMatch(/max-width:/);
  });

  it('the dropdown component applies the computed floor/cap and clamps the measured width', () => {
    const component = read('packages/desktop/src/renderer/components/billing/MediaModelDropdown.tsx');
    expect(component).toContain('minWidth: placement.minWidth');
    expect(component).toContain('maxWidth: placement.maxWidth');
    expect(component).toContain('clampPillDropdownLeft({');
    expect(component).toContain('viewportWidth: window.innerWidth');
  });
});

describe('image/video PARITY — one surface by construction', () => {
  it('both pills render through the shared dropdown component', () => {
    for (const pill of [
      'packages/desktop/src/renderer/components/billing/ImageModelPill.tsx',
      'packages/desktop/src/renderer/components/billing/VideoQualityPill.tsx',
    ]) {
      const source = read(pill);
      expect(source, `${pill} left the shared dropdown`).toContain(
        "from '@/renderer/components/billing/MediaModelDropdown'"
      );
      expect(source).toContain('MediaModelDropdown');
      expect(source, `${pill} forked its own list styling`).not.toMatch(/__model-list[a-z-]*\s*\{/);
    }
  });

  it('neither pill re-declares the dropdown classes in a private stylesheet', () => {
    // The classes live ONLY in billing.css — a second declaration site is how
    // the two lanes would drift apart visually.
    const declarations = [...css.matchAll(/\.video-quality-pill__model-list\s*\{/g)];
    expect(declarations).toHaveLength(1);
  });
});
