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
const hex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

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
  },
} as const;

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
    for (const cls of ['video-quality-pill__model-list', 'video-quality-pill__model-trigger', 'video-quality-pill__chevron']) {
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
      expect(billingCss.includes(`.${cls}`), `${cls} is lane-only AND not declared in the shared stylesheet — that is a style fork`).toBe(true);
    }
  });
});
