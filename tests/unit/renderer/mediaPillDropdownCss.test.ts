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
    // The trigger and the hovered row are SURFACES now, not framed boxes
    // (founder, 1.821.0) — so what they must consume is the row tint.
    ['.video-quality-pill__model-trigger', ['var(--eve-row-hover-bg)']],
    ['.video-quality-pill__model-trigger:hover', ['var(--eve-row-selected-bg)']],
    ['.video-quality-pill__model-entry:hover:not(:disabled)', ['var(--eve-row-hover-bg)']],
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

describe('the LEGACY FALLBACK radios speak EVE too — they render exactly when the catalog fetch failed', () => {
  // The catalog path went EVE-glass in the dropdown fix; the legacy radios
  // (VideoQualityPill / ImageModelPill else-branches, shown when no catalog or
  // selectedSpec is available) kept the foreign vocabulary — a bright
  // #2563eb/#e5e7eb moment at precisely the time something is already wrong.
  const RADIO_CONSUMPTION: Array<[string, string[]]> = [
    ['.video-quality-pill__option:hover', ['var(--eve-row-hover-bg)']],
    ['.video-quality-pill__option:focus-visible', ['var(--eve-focus-ring)']],
    ['.video-quality-pill__option.is-selected', ['var(--eve-max-accent)']],
    ['.image-model-pill__option:hover', ['var(--eve-row-hover-bg)']],
    ['.image-model-pill__option:focus-visible', ['var(--eve-focus-ring)']],
    ['.image-model-pill__option.is-selected', ['var(--eve-max-accent)']],
  ];

  it.each(RADIO_CONSUMPTION)('%s reads its EVE tokens and none of the foreign ones', (selector, tokens) => {
    const body = ruleBody(selector);
    for (const token of tokens) {
      expect(body.includes(token), `${selector} no longer reads ${token}`).toBe(true);
    }
    for (const foreign of ['--border-secondary', '--color-primary-6', '#e5e7eb', '#2563eb']) {
      expect(body.includes(foreign), `${selector} carries foreign vocabulary again: ${foreign}`).toBe(false);
    }
  });

  it('focus stays an OUTLINE, visually distinct from is-selected (the priced-control argument)', () => {
    // The comment above these rules is load-bearing: focused is not chosen, an
    // outline cannot be confused with the selected SURFACE treatment and does
    // not participate in layout. Both families keep that shape.
    for (const family of ['.video-quality-pill__option', '.image-model-pill__option']) {
      const focus = ruleBody(`${family}:focus-visible`);
      expect(focus).toMatch(/outline:\s*2px solid var\(--eve-focus-ring\)/);
      expect(focus, 'focus must not paint a surface — that is the selected treatment').not.toMatch(/background/);
      const selected = ruleBody(`${family}.is-selected`);
      expect(selected, 'selected is a tinted surface, not a ring').toMatch(
        /background:\s*color-mix\(in srgb, var\(--eve-max-accent\)/
      );
      expect(selected, 'selected must not claim the outline — that is the focus treatment').not.toMatch(/outline:/);
    }
  });

  it('no dead --eve-max-accent fallback chains anywhere in the pill families', () => {
    // The dropdown cleanup removed eight of these; the radios carried three
    // more. The token is always declared — a #2563eb fallback is dead weight
    // that doubles as foreign vocabulary.
    expect(css.includes('var(--eve-max-accent, var(--color-primary-6')).toBe(false);
  });
});

describe('SELECTION IS A SURFACE, NEVER A RING (founder, 1.821.0)', () => {
  // "das umrahmen, das wirkt altbacken, und eigentlich haben wir solche rahmen
  //  auch nirgendsmehr bei uns in command eve" — and he is right: the shipped
  // EVE selection idiom is a tinted surface plus a left inset hairline, never
  // an enclosing outline. These assertions encode THAT contract; they are not
  // satisfiable by re-tinting a border back into existence.

  /** Every interactive state of the two media menus. */
  const STATE_RULES = [
    '.video-quality-pill__option:hover',
    '.video-quality-pill__option.is-selected',
    '.video-quality-pill__model-trigger',
    '.video-quality-pill__model-trigger:hover',
    ".video-quality-pill__model-trigger[aria-expanded='true']",
    '.video-quality-pill__model-trigger.is-active',
    '.video-quality-pill__model-entry:hover:not(:disabled)',
    '.video-quality-pill__model-entry.is-selected',
    '.image-model-pill__option:hover',
    '.image-model-pill__option.is-selected',
    '.image-model-pill__option--max.is-selected',
  ];

  it.each(STATE_RULES)('%s paints no border-colour at all', (selector) => {
    expect(ruleBody(selector), `${selector} draws a frame again — that is the look the founder rejected`).not.toMatch(
      /border-color:/
    );
  });

  it('the whole stylesheet is free of border-colour state painting', () => {
    // A blunt second lock: a new state rule elsewhere in the file cannot
    // reintroduce the idiom without this test going red first.
    expect(css).not.toMatch(/border-color:/);
  });

  it('the ONE surviving edge is the floating overlay against the backdrop, not a selection', () => {
    // This is the same hairline every other EVE overlay uses; it separates the
    // portaled menu from whatever is behind it and was never a selection mark.
    expect(ruleBody('.video-quality-pill__model-list')).toMatch(/border:\s*1px solid var\(--glass-overlay-border\)/);
  });

  it('the transparent 1px reserve stays, so removing the ring shifts no layout', () => {
    for (const base of [
      '.video-quality-pill__option',
      '.video-quality-pill__model-entry',
      '.image-model-pill__option',
    ]) {
      expect(ruleBody(base), `${base} lost its layout reserve — pills will jump on select`).toMatch(
        /border:\s*1px solid transparent/
      );
    }
  });

  it('selection = accent text + accent tint, on every selectable surface', () => {
    for (const selector of [
      '.video-quality-pill__option.is-selected',
      '.image-model-pill__option.is-selected',
      '.image-model-pill__option--max.is-selected',
      '.video-quality-pill__model-entry.is-selected',
    ]) {
      const body = ruleBody(selector);
      expect(body, `${selector} lost the accent text`).toContain('color: var(--eve-max-accent)');
      expect(body, `${selector} lost the tinted surface`).toMatch(
        /background:\s*color-mix\(in srgb, var\(--eve-max-accent\)\s*\d+%, transparent\)/
      );
    }
  });

  it('the dropdown row speaks the .eve-row--selected shape verbatim (tint + LEFT inset hairline)', () => {
    expect(ruleBody('.video-quality-pill__model-entry.is-selected')).toMatch(
      /box-shadow:\s*inset 2px 0 0 var\(--eve-max-accent\)/
    );
    // Evidence anchor: the idiom being copied is the shipped one, by SYMBOL.
    const visual = read('packages/desktop/src/renderer/styles/themes/command-eve-visual.css');
    expect(visual, 'the .eve-row selection idiom moved — re-anchor this claim').toContain(
      'box-shadow: inset 2px 0 0 var(--eve-row-selected-hairline)'
    );
  });

  it('the premium tier stays the QUIETER of the two — the gradation survived the ring removal', () => {
    const share = (selector: string): number => {
      const match = ruleBody(selector).match(
        /background:\s*color-mix\(in srgb, var\(--eve-max-accent\)\s*(\d+)%, transparent\)/
      );
      expect(match, `${selector} has no accent tint to weigh`).not.toBeNull();
      return Number((match as RegExpMatchArray)[1]);
    };
    const standard = share('.image-model-pill__option.is-selected');
    const max = share('.image-model-pill__option--max.is-selected');
    expect(max, 'the MAX tier is no longer the quieter treatment').toBeLessThan(standard);
    expect(max, 'the quieter tier fell below the established row-selected step (light 6%)').toBeGreaterThanOrEqual(6);
  });

  it('the trigger ladder is pinned in the order that MAKES it a ladder', () => {
    // `.is-active`, `:hover` and `[aria-expanded]` all weigh the same, so their
    // source order is not a formatting detail — it is the behaviour. Reorder
    // them and a pinned trigger stops answering the pointer, or opening the
    // menu starts looking quieter than not opening it.
    const rungs = [
      '.video-quality-pill__model-trigger {',
      '.video-quality-pill__model-trigger.is-active {',
      '.video-quality-pill__model-trigger:hover {',
      ".video-quality-pill__model-trigger[aria-expanded='true'] {",
    ].map((rung) => {
      const at = css.indexOf(rung);
      expect(at, `trigger rung missing: ${rung}`).toBeGreaterThan(-1);
      return at;
    });
    for (let i = 1; i < rungs.length; i += 1) {
      expect(rungs[i], 'the trigger state ladder is out of order').toBeGreaterThan(rungs[i - 1]);
    }
  });

  it('every rung of the trigger ladder is a distinct surface — no dead state', () => {
    const surface = (selector: string): string => {
      const match = ruleBody(selector).match(/background:\s*([^;]+);/);
      expect(match, `${selector} paints no surface at all`).not.toBeNull();
      return (match as RegExpMatchArray)[1].trim();
    };
    const painted = [
      surface('.video-quality-pill__model-trigger'),
      surface('.video-quality-pill__model-trigger.is-active'),
      surface('.video-quality-pill__model-trigger:hover'),
      surface(".video-quality-pill__model-trigger[aria-expanded='true']"),
    ];
    expect(new Set(painted).size, `two trigger states paint the same surface: ${painted.join(' | ')}`).toBe(
      painted.length
    );
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
    expect(component).toContain('alignMeasuredPillDropdownTop({');
    expect(component).toContain('measuredHeight: listRect.height');
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
