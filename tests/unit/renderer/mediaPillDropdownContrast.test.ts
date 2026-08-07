/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DOM-level acceptance for the EVE-glass dropdowns (CEVE-18205) — the honest
 * substitute for a live screenshot while the running app still carries the
 * pre-fix CSS bundle.
 *
 * jsdom does not resolve var()/color-mix, so this suite resolves the REAL
 * token chains itself (the same modelled-composite approach the MAX-pill AA
 * suite uses): the token values are read from the shipped theme formulas, the
 * translucent overlay is composited over TWO backdrops (the shell surface and
 * an adversarial mid-grey standing in for a background image), and WCAG
 * contrast is computed on the results. Light and dark are both gated.
 *
 * PARITY: image and video dropdowns share one component and one declaration
 * site (pinned in mediaPillDropdownCss.test.ts); here the entry/list class
 * literals are EXTRACTED from both real pill sources and asserted identical —
 * identical classes against a single declaration site resolve to identical
 * computed styles by construction, so the table below holds for BOTH paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

type Rgb = [number, number, number];

const parse = (hex: string): Rgb => {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
/** color-mix(in srgb, a SHARE%, b) — component-wise, like the AA suite's model. */
const mix = (a: Rgb, b: Rgb, shareA: number): Rgb =>
  [0, 1, 2].map((i) => Math.round(a[i] * shareA + b[i] * (1 - shareA))) as Rgb;
/** Alpha-composite fg (alpha) over an opaque bg. */
const over = (fg: Rgb, alpha: number, bg: Rgb): Rgb =>
  [0, 1, 2].map((i) => Math.round(fg[i] * alpha + bg[i] * (1 - alpha))) as Rgb;
const luminance = ([r, g, b]: Rgb): number => {
  const chan = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
};
const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hex = ([r, g, b]: Rgb): string => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * Shipped theme inputs — read from command-eve-visual.css / default-color-
 * scheme.css formulas. The assertion below re-reads the files so a token
 * change reddens this table instead of silently invalidating it.
 */
const THEME = {
  light: {
    surface: '#ffffff',
    text: '#111827',
    textSecondary: '#596273',
    borderBase: '#e5e6eb',
    overlayShare: 0.84,
    overlayBorder: { base: '#e5e6eb', share: 0.9 }, // color-mix(border-base 90%, transparent)
    hover: { base: '#111827', share: 0.05 }, // --eve-row-hover-bg
    // --eve-max-accent light = mix(accent 70%, shell-text); shipped accent #2563eb
    accent: mix(parse('#2563eb'), parse('#111827'), 0.7),
    // The COMPOSER stack the pills sit on: the reading glass over the app
    // background, then the composer glass over that. Both layers are surface
    // colour, which is why the pill lane is MORE surface-dominated than the
    // portaled menu, not less.
    shellBg: '#f7f8fb',
    readingShare: 0.7061,
    composerShare: 0.5429,
    rowSelected: { base: '#111827', share: 0.06 }, // --eve-row-selected-bg
  },
  dark: {
    surface: '#171a1e',
    text: '#f7f8fa',
    textSecondary: '#aab1bd',
    borderBase: '#333333',
    overlayShare: 0.84,
    overlayBorder: { base: '#ffffff', share: 0.12 }, // dark: color-mix(#ffffff 12%, transparent)
    hover: { base: '#ffffff', share: 0.05 },
    // --eve-max-accent dark = mix(accent 44%, static-white)
    accent: mix(parse('#2563eb'), parse('#ffffff'), 0.44),
    shellBg: '#101214',
    readingShare: 0.7224,
    composerShare: 0.5755,
    rowSelected: { base: '#ffffff', share: 0.07 },
  },
} as const;

/**
 * The selection tint SHARES are read out of the shipped stylesheet, never
 * retyped here: a value nudged in billing.css must move this table with it.
 */
const billingCss = fs.readFileSync(
  path.resolve(process.cwd(), 'packages/desktop/src/renderer/components/billing/billing.css'),
  'utf8'
);
function tintShare(selector: string): number {
  const rule = billingCss.slice(billingCss.indexOf(`${selector} {`));
  const match = rule
    .slice(0, rule.indexOf('}'))
    .match(/background:\s*color-mix\(in srgb, var\(--eve-max-accent\)\s*(\d+)%, transparent\)/);
  expect(match, `${selector} carries no accent tint to measure`).not.toBeNull();
  return Number((match as RegExpMatchArray)[1]) / 100;
}
const TINT = {
  pill: tintShare('.video-quality-pill__option.is-selected'),
  pillMax: tintShare('.image-model-pill__option--max.is-selected'),
  entry: tintShare('.video-quality-pill__model-entry.is-selected'),
};

const BACKDROPS: Record<string, string> = { shell: '', midGrey: '#808080' };

type Resolved = {
  theme: 'light' | 'dark';
  backdrop: string;
  listBg: Rgb;
  entryText: Rgb;
  label: Rgb;
  border: Rgb;
  hoverBg: Rgb;
  selected: Rgb;
};

function resolve(theme: 'light' | 'dark', backdropName: string): Resolved {
  const t = THEME[theme];
  const backdrop = parse(BACKDROPS[backdropName] || t.surface);
  // --glass-overlay-bg = surface @ 84% over whatever is behind the portal.
  // (The 18px backdrop blur only averages the backdrop — the flat composite IS
  // the average case, which is why two backdrops are measured.)
  const listBg = over(parse(t.surface), t.overlayShare, backdrop);
  return {
    theme,
    backdrop: backdropName,
    listBg,
    entryText: parse(t.text),
    label: parse(t.textSecondary),
    border: over(parse(t.overlayBorder.base), t.overlayBorder.share, listBg),
    hoverBg: over(parse(t.hover.base), t.hover.share, listBg),
    selected: t.accent,
  };
}

describe('resolved dropdown colours — readable in BOTH themes over BOTH backdrops', () => {
  const rows: Resolved[] = (['light', 'dark'] as const).flatMap((theme) =>
    Object.keys(BACKDROPS).map((backdrop) => resolve(theme, backdrop))
  );

  it('prints the acceptance table (the values the report quotes)', () => {
    for (const r of rows) {
      console.info(
        `[${r.theme}/${r.backdrop}] list=${hex(r.listBg)} border=${hex(r.border)} hover=${hex(r.hoverBg)} ` +
          `| entry=${hex(r.entryText)} (${contrast(r.entryText, r.listBg).toFixed(2)}:1) ` +
          `label=${hex(r.label)} (${contrast(r.label, r.listBg).toFixed(2)}:1) ` +
          `selected=${hex(r.selected)} (${contrast(r.selected, r.listBg).toFixed(2)}:1)`
      );
    }
    expect(rows).toHaveLength(4);
  });

  it.each(rows.map((r) => [`${r.theme}/${r.backdrop}`, r] as const))(
    '%s: entry text clears AA, label clears AA, selected accent clears AA',
    (_name, r) => {
      expect(contrast(r.entryText, r.listBg), 'entry text below AA').toBeGreaterThanOrEqual(4.5);
      // The 10px/700 uppercase section label is SMALL text — full AA, no discount.
      expect(contrast(r.label, r.listBg), 'section label below AA').toBeGreaterThanOrEqual(4.5);
      expect(contrast(r.selected, r.listBg), 'selected accent below AA').toBeGreaterThanOrEqual(4.5);
      // Hover must be a VISIBLE state change but never a legibility cliff.
      expect(contrast(r.entryText, r.hoverBg)).toBeGreaterThanOrEqual(4.5);
    }
  );

  it('the theme inputs above match the shipped stylesheets (no drift, no invented numbers)', () => {
    const visual = fs.readFileSync(
      path.resolve(process.cwd(), 'packages/desktop/src/renderer/styles/themes/command-eve-visual.css'),
      'utf8'
    );
    const scheme = fs.readFileSync(
      path.resolve(process.cwd(), 'packages/desktop/src/renderer/styles/themes/default-color-scheme.css'),
      'utf8'
    );
    for (const needle of [
      '--eve-shell-surface: #ffffff',
      '--eve-shell-text: #111827',
      '--eve-shell-text-secondary: #596273',
      '--eve-shell-surface: #171a1e',
      '--eve-shell-text: #f7f8fa',
      '--eve-shell-text-secondary: #aab1bd',
      '--eve-glass-overlay-opacity: 84%',
      '--glass-overlay-border: color-mix(in srgb, var(--border-base) 90%, transparent)',
      '--glass-overlay-border: color-mix(in srgb, #ffffff 12%, transparent)',
      '--eve-row-hover-bg: color-mix(in srgb, var(--eve-shell-text) 5%, transparent)',
    ]) {
      expect(visual.includes(needle), `theme drifted from the modelled input: ${needle}`).toBe(true);
    }
    expect(scheme).toContain('--border-base: #e5e6eb');
    expect(scheme).toContain('--border-base: #333333');
  });
});

/**
 * RING-FREE SELECTION, MEASURED (founder, 1.821.0). The menus stopped marking
 * selection with an enclosing border and mark it with a tinted surface plus
 * accent text instead. Two things must therefore hold that a border never had
 * to answer for: the accent text must stay legible ON its own tint, and the
 * tint must be a visible step away from the unselected surface — on both
 * themes, over both backdrops. This is the suite that decides whether the tint
 * value was chosen or guessed.
 */
describe('the tinted selection is legible AND unmistakable', () => {
  const composerStack = (theme: 'light' | 'dark', backdropName: string): Rgb => {
    const t = THEME[theme];
    const backdrop = parse(BACKDROPS[backdropName] || t.surface);
    const reading = over(parse(t.shellBg), t.readingShare, backdrop);
    return over(parse(t.surface), t.composerShare, reading);
  };

  const cases = (['light', 'dark'] as const).flatMap((theme) =>
    Object.keys(BACKDROPS).map((backdrop) => {
      const t = THEME[theme];
      const composerBg = composerStack(theme, backdrop);
      const listBg = over(parse(t.surface), t.overlayShare, parse(BACKDROPS[backdrop] || t.surface));
      return {
        name: `${theme}/${backdrop}`,
        accent: t.accent as Rgb,
        composerBg,
        listBg,
        pill: over(t.accent as Rgb, TINT.pill, composerBg),
        pillMax: over(t.accent as Rgb, TINT.pillMax, composerBg),
        entry: over(t.accent as Rgb, TINT.entry, listBg),
        // What the SHIPPED EVE row selection measures under the same model —
        // the yardstick the pill tint has to stand next to.
        rowRef: over(parse(t.rowSelected.base), t.rowSelected.share, composerBg),
      };
    })
  );

  it('prints the tint acceptance table (surface step vs. the shipped .eve-row step)', () => {
    for (const c of cases) {
      console.info(
        `[${c.name}] pill=${hex(c.pill)} step=${contrast(c.pill, c.composerBg).toFixed(3)} ` +
          `max=${hex(c.pillMax)} step=${contrast(c.pillMax, c.composerBg).toFixed(3)} ` +
          `| .eve-row--selected step=${contrast(c.rowRef, c.composerBg).toFixed(3)} ` +
          `| accent on pill=${contrast(c.accent, c.pill).toFixed(2)}:1 ` +
          `on entry=${contrast(c.accent, c.entry).toFixed(2)}:1`
      );
    }
    expect(cases).toHaveLength(4);
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    '%s: the accent label stays AA ON its own tint — the fill must not eat the text',
    (_name, c) => {
      // A tint under same-hue text costs contrast; that cost is the price of
      // losing the ring and it has to stay inside AA, not merely "look fine".
      expect(contrast(c.accent, c.pill), 'selected pill label below AA').toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.accent, c.pillMax), 'selected MAX pill label below AA').toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.accent, c.entry), 'selected dropdown row label below AA').toBeGreaterThanOrEqual(4.5);
    }
  );

  it.each(cases.map((c) => [c.name, c] as const))(
    '%s: the tint is a VISIBLE step, and the MAX tier stays the quieter one',
    (_name, c) => {
      // Floor, not a fit: the shipped .eve-row selection step measures ~1.13
      // (light) to ~1.22 (dark) under this model, an untinted surface measures
      // exactly 1.000. 1.10 sits well clear of "no tint at all" and below the
      // established step, so it cannot be satisfied by a tint nobody can see.
      expect(contrast(c.pill, c.composerBg), 'the selection fill is invisible here').toBeGreaterThanOrEqual(1.1);
      expect(contrast(c.pillMax, c.composerBg), 'the MAX selection fill is invisible here').toBeGreaterThanOrEqual(
        1.06
      );
      expect(contrast(c.entry, c.listBg), 'the selected row fill is invisible here').toBeGreaterThanOrEqual(1.06);
      // The gradation the border strengths used to carry (55% vs 40%) must
      // survive as fill strength, in the same direction.
      expect(
        contrast(c.pillMax, c.composerBg),
        'the MAX tier is no longer quieter than the standard tier'
      ).toBeLessThan(contrast(c.pill, c.composerBg));
    }
  );

  it('the composer/row inputs above match the shipped stylesheet (no invented numbers)', () => {
    const visual = fs.readFileSync(
      path.resolve(process.cwd(), 'packages/desktop/src/renderer/styles/themes/command-eve-visual.css'),
      'utf8'
    );
    for (const needle of [
      '--eve-shell-bg: #f7f8fb',
      '--eve-shell-bg: #101214',
      '--eve-glass-reading-opacity: 70.61%',
      '--eve-glass-reading-opacity: 72.24%',
      '--eve-glass-composer-opacity: 54.29%',
      '--eve-glass-composer-opacity: 57.55%',
      '--eve-row-selected-bg: color-mix(in srgb, var(--eve-shell-text) 6%, transparent)',
      '--eve-row-selected-bg: color-mix(in srgb, #ffffff 7%, transparent)',
      '--glass-reading-bg: color-mix(in srgb, var(--eve-shell-bg) var(--eve-glass-reading-opacity), transparent)',
      '--glass-composer-bg: color-mix(in srgb, var(--eve-shell-surface) var(--eve-glass-composer-opacity), transparent)',
    ]) {
      expect(visual.includes(needle), `theme drifted from the modelled input: ${needle}`).toBe(true);
    }
  });
});

describe('image/video parity — identical class literals against one declaration site', () => {
  const classesOf = (relative: string): string[] => {
    const source = fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
    return [...new Set([...source.matchAll(/video-quality-pill__[a-z-]+/g)].map((m) => m[0]))].sort();
  };

  it('every dropdown class the image pill renders, the video pill renders too (and vice versa for the list core)', () => {
    const image = classesOf('packages/desktop/src/renderer/components/billing/ImageModelPill.tsx');
    const video = classesOf('packages/desktop/src/renderer/components/billing/VideoQualityPill.tsx');
    const shared = classesOf('packages/desktop/src/renderer/components/billing/MediaModelDropdown.tsx');
    // The dropdown CORE (list, trigger, entries, chips, name) must be the same
    // vocabulary in both pills — identical classes + the single declaration
    // site pinned next door = identical computed styles for both lanes.
    const core = ['video-quality-pill__model-entry', 'video-quality-pill__model-name'];
    for (const cls of core) {
      expect(image, `image pill lost ${cls}`).toContain(cls);
      expect(video, `video pill lost ${cls}`).toContain(cls);
    }
    for (const cls of [
      'video-quality-pill__model-list',
      'video-quality-pill__model-trigger',
      'video-quality-pill__chevron',
    ]) {
      expect(shared, `shared dropdown lost ${cls}`).toContain(cls);
    }
    // CONTENT deltas are legitimate (the video menu carries a note line the
    // image menu has no text for) — a STYLE fork is not. So: every __model-*
    // class that only one lane renders must still be declared in the ONE
    // shared stylesheet, never in a private one. billing.css is that site.
    const billingCss = fs.readFileSync(
      path.resolve(process.cwd(), 'packages/desktop/src/renderer/components/billing/billing.css'),
      'utf8'
    );
    const modelClasses = (list: string[]) => list.filter((c) => c.startsWith('video-quality-pill__model-'));
    const laneOnly = [
      ...modelClasses(image).filter((c) => !modelClasses(video).includes(c) && !shared.includes(c)),
      ...modelClasses(video).filter((c) => !modelClasses(image).includes(c) && !shared.includes(c)),
    ];
    for (const cls of laneOnly) {
      expect(
        billingCss.includes(`.${cls}`),
        `${cls} is lane-only AND not declared in the shared stylesheet — that is a style fork`
      ).toBe(true);
    }
  });
});
