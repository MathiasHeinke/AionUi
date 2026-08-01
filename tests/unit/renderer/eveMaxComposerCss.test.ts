/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The MAX composer visual contract, asserted against the stylesheet itself.
 *
 * jsdom does not apply real CSS, so a DOM test can prove the `data-eve-max`
 * attribute toggles but NOT what that attribute paints. This file closes that
 * gap by reading the actual stylesheet and pinning the four decisions the design
 * rests on:
 *
 *   1. MAX is implemented by RE-POINTING the composer's existing variables —
 *      not by a new element and not by a competing class rule, which would lose
 *      the specificity war against sendbox.css's `border-color … !important`.
 *   2. Both reduced-motion signals are honoured, and BOTH keep the state while
 *      dropping only the motion.
 *   3. No hardcoded colour anywhere in the MAX layer.
 *   4. The composer's `!important` border really does read the variable, which
 *      is the entire reason re-pointing works.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EVE_ACCENTS } from '@/renderer/theme/visualPreferences';

const VISUAL_CSS = path.resolve(
  __dirname,
  '../../../packages/desktop/src/renderer/styles/themes/command-eve-visual.css'
);
const SENDBOX_CSS = path.resolve(
  __dirname,
  '../../../packages/desktop/src/renderer/components/chat/SendBox/sendbox.css'
);

const DEFAULT_SCHEME_CSS = path.resolve(
  __dirname,
  '../../../packages/desktop/src/renderer/styles/themes/default-color-scheme.css'
);

const css = fs.readFileSync(VISUAL_CSS, 'utf-8');
const sendboxCss = fs.readFileSync(SENDBOX_CSS, 'utf-8');
const defaultSchemeCss = fs.readFileSync(DEFAULT_SCHEME_CSS, 'utf-8');
/** Every stylesheet that is loaded alongside the composer at runtime. */
const loadedCss = `${defaultSchemeCss}\n${css}\n${sendboxCss}`;

/** Custom properties DECLARED anywhere in the loaded stylesheets. */
function declaredCustomProperties(source: string): Set<string> {
  return new Set((source.match(/(^|[;{\s])(--[a-z0-9-]+)\s*:/gi) ?? []).map((m) => m.match(/--[a-z0-9-]+/i)![0]));
}

/** The declaration body of the first rule whose selector matches exactly. */
function ruleBody(source: string, selector: string): string {
  const index = source.indexOf(`${selector} {`);
  if (index === -1) throw new Error(`selector not found: ${selector}`);
  const start = source.indexOf('{', index);
  const end = source.indexOf('}', start);
  return source.slice(start + 1, end);
}

describe('MAX composer state — the CSS-variable seam', () => {
  it('re-points the composer variables instead of adding a new element or class', () => {
    const body = ruleBody(css, ".eve-composer-surface[data-eve-max='true']");
    expect(body).toMatch(/--eve-spotlight-color:\s*var\(--eve-max-accent\)/);
    expect(body).toMatch(/--eve-composer-border:\s*var\(--eve-max-composer-border\)/);
    expect(body).toMatch(/--eve-spotlight-max:\s*var\(--eve-max-spotlight-ceiling\)/);
    // No direct paint: the rule sets variables ONLY. A `border-color` here would
    // be the losing move against sendbox.css's !important.
    expect(body).not.toMatch(/^\s*border(-color)?\s*:/m);
    expect(body).not.toMatch(/^\s*background\s*:/m);
  });

  it('is the ONLY thing needed because the composer border reads that variable through !important', () => {
    // FACT: sendbox.css re-declares the border with !important. That declaration
    // READS --eve-composer-border, so re-pointing the variable wins regardless.
    expect(sendboxCss).toMatch(/\.sendbox-panel\.eve-composer-surface\s*\{[^}]*--eve-composer-border[^}]*!important/s);
    expect(css).toMatch(/\.eve-composer-surface\s*\{[^}]*border:\s*1px solid var\(--eve-composer-border\) !important/s);
  });

  it('both composer pseudo-elements consume the re-pointed spotlight colour', () => {
    // This is why the WHOLE composer shifts together: hairline, ring and glow
    // all read the same variable.
    expect(ruleBody(css, '.eve-composer-surface::before')).toContain('var(--eve-spotlight-color)');
    expect(ruleBody(css, '.eve-composer-surface::after')).toContain('var(--eve-spotlight-color)');
  });

  it('defines the MAX tokens from the existing token layer — no hardcoded colours', () => {
    const maxTokens = css.match(/--eve-max-[a-z-]+:[^;]+;/g) ?? [];
    expect(maxTokens.length).toBeGreaterThanOrEqual(3);
    for (const token of maxTokens) {
      expect(token).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(token).not.toMatch(/\brgba?\(/i);
      expect(token).not.toMatch(/\bhsla?\(/i);
    }
    // The accent is DERIVED from the token layer with a per-theme lightness
    // adjustment (R5) — see the contrast suite for why a bare var() is not enough.
    expect(css).toMatch(/--eve-max-accent:\s*color-mix\([^;]*var\(--eve-accent/);
    expect(css).toMatch(/--eve-max-composer-border:\s*color-mix\([^;]*var\(--eve-max-accent\)/);
  });

  it('every custom property the MAX layer REFERENCES is actually DECLARED somewhere', () => {
    // A var() that resolves to nothing is not a harmless no-op here. Measured
    // failure mode: if the accent chain resolves empty, `border: 1px solid
    // var(--eve-composer-border)` becomes an INVALID shorthand and the composer
    // border disappears entirely (1px -> 0px). `--color-primary-6` was exactly
    // such a dead fallback: referenced, declared nowhere. This is also the class
    // of bug that silently killed the earlier tint exploration, so it gets a
    // source-level guard rather than trust.
    const declared = declaredCustomProperties(loadedCss);

    const maxLayer = [
      ...(css.match(/--eve-max-[a-z-]+:[^;]+;/g) ?? []),
      ...(css.match(/\[data-eve-max='true'\][^{]*\{[^}]*\}/g) ?? []),
    ].join('\n');
    expect(maxLayer.length).toBeGreaterThan(0);

    const referenced = new Set(
      (maxLayer.match(/var\(\s*(--[a-z0-9-]+)/gi) ?? []).map((m) => m.match(/--[a-z0-9-]+/i)![0])
    );
    expect(referenced.size).toBeGreaterThan(0);

    for (const name of referenced) {
      expect(declared.has(name), `${name} is referenced by the MAX layer but declared nowhere`).toBe(true);
    }

    // Pin the specific regression: the dead fallback must not come back.
    expect(css).not.toContain('--eve-max-accent: var(--eve-accent, var(--color-primary-6))');
    expect(declared.has('--primary')).toBe(true);
  });

  it('works in BOTH themes: the dark block re-states the MAX border and ceiling', () => {
    const darkBlockStart = css.indexOf(":root[data-theme='dark']");
    expect(darkBlockStart).toBeGreaterThan(-1);
    const darkBlock = css.slice(darkBlockStart, css.indexOf('}', darkBlockStart));
    expect(darkBlock).toMatch(/--eve-max-composer-border:/);
    expect(darkBlock).toMatch(/--eve-max-spotlight-ceiling:/);
  });

  it('MOTION is calm: one ease transition on engage, and no infinite animation', () => {
    const motion = ruleBody(
      css,
      ".eve-composer-surface[data-eve-max='true']::before,\n.eve-composer-surface[data-eve-max='true']::after"
    );
    expect(motion).toMatch(/transition:[^;]*ease/);
    expect(motion).not.toMatch(/infinite/);
    // And nothing anywhere in the MAX layer starts a looping animation.
    const maxRules = css.match(/\[data-eve-max='true'\][^{]*\{[^}]*\}/g) ?? [];
    expect(maxRules.length).toBeGreaterThan(0);
    for (const rule of maxRules) {
      expect(rule).not.toMatch(/infinite/);
    }
  });
});

describe('MAX toggle pill — the three real-app visual defects (R1/R2/R3)', () => {
  const sendBarCss = fs.readFileSync(
    path.resolve(__dirname, '../../../packages/desktop/src/renderer/components/chat/UnifiedSendBar.css'),
    'utf-8'
  );

  it('R2: the toggle OPTS OUT of the 32x32 compact-pill footprint and sizes itself', () => {
    // The shared rule clamps width/min-width to the control size. MAX is the one
    // pill carrying a word, so it must declare auto width or its label overflows
    // the layout box and steals the neighbour's hit target.
    expect(sendBarCss).toMatch(/\[data-testid='eve-max-toggle'\]\s*\{[^}]*width:\s*auto\s*!important/s);
    expect(sendBarCss).toMatch(/\[data-testid='eve-max-toggle'\]\s*\{[^}]*min-width:\s*auto\s*!important/s);
    // ...and it restores a real content box on the component's OWN inner span
    // (this button renders no .arco-btn-content wrapper at all).
    expect(sendBarCss).toMatch(/\.eve-max-toggle__content\s*\{[^}]*width:\s*auto/s);
    expect(sendBarCss).toMatch(/\.eve-max-toggle__label\s*\{[^}]*display:\s*inline\s*!important/s);
  });

  it('R1: the toggle declares its own colour on its OWN class — never through :where()', () => {
    // `:where()` contributes ZERO specificity, which is exactly how the bar's
    // colour rule lost to Arco's two-class disabled rule and left white text on
    // a near-white composer. Every MAX colour rule must be written on real
    // classes so it wins on its own merits.
    const maxRules = sendBarCss.match(/\.unified-send-bar[^{]*\.eve-max-toggle[^{]*\{[^}]*\}/gs) ?? [];
    expect(maxRules.length).toBeGreaterThan(0);
    for (const rule of maxRules) {
      const selector = rule.slice(0, rule.indexOf('{'));
      expect(selector, 'MAX colour must not route through :where()').not.toContain(':where(');
    }
    // The DISABLED state explicitly re-declares a legible colour rather than
    // inheriting whatever Arco's primary-disabled rule produces.
    expect(sendBarCss).toMatch(/\[data-testid='eve-max-toggle'\]\[disabled\]/);
    expect(sendBarCss).toMatch(/\[data-testid='eve-max-toggle'\]\.arco-btn-disabled/);
  });

  it('R1: no hardcoded colour in the MAX pill layer — disabled/locked stay theme-aware', () => {
    const maxRules = (sendBarCss.match(/\.unified-send-bar[^{]*\.eve-max-toggle[^{]*\{[^}]*\}/gs) ?? []).join('\n');
    expect(maxRules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(maxRules).not.toMatch(/\brgba?\(/i);
  });

  it('R3: engaging MAX actually changes the pill, keyed on data-active', () => {
    // data-ACTIVE, not data-engaged: a lapsed seat keeps the intent but the wire
    // clamps, so the pill must not light up for a lane that is not running.
    expect(sendBarCss).toMatch(/\[data-testid='eve-max-toggle'\]\[data-active='true'\]/);
    const activeRule = sendBarCss.match(/\[data-testid='eve-max-toggle'\]\[data-active='true'\]\s*\{[^}]*\}/s);
    expect(activeRule).not.toBeNull();
    expect(activeRule![0]).toMatch(/background:/);
    expect(activeRule![0]).toMatch(/color:/);
    // Shares the composer's MAX accent so pill and surface read as ONE state.
    expect(activeRule![0]).toContain('--eve-max-accent');
  });

  it('every custom property the MAX PILL references is declared somewhere', () => {
    const declared = declaredCustomProperties(`${loadedCss}\n${sendBarCss}`);
    const maxRules = (sendBarCss.match(/\.unified-send-bar[^{]*\.eve-max-toggle[^{]*\{[^}]*\}/gs) ?? []).join('\n');
    const referenced = new Set(
      (maxRules.match(/var\(\s*(--[a-z0-9-]+)/gi) ?? []).map((m) => m.match(/--[a-z0-9-]+/i)![0])
    );
    expect(referenced.size).toBeGreaterThan(0);
    for (const name of referenced) {
      expect(declared.has(name), `${name} is referenced by the MAX pill but declared nowhere`).toBe(true);
    }
  });
});

describe('MAX pill label — WCAG AA contrast in BOTH themes (R5)', () => {
  /**
   * Computed here, not left to the Electron capture, because the failure was
   * silent: `--eve-accent` is OVERWRITTEN AT RUNTIME by visualPreferences.ts with
   * the SAME literal for light and dark, so the "theme-aware" accent was not
   * theme-aware at all and the dark label measured 2.44:1. A stylesheet-only
   * review could not see that; arithmetic over the real shipped accents can.
   *
   * The CSS computes:
   *   light: color-mix(accent 70%, --eve-shell-text)
   *   dark:  color-mix(accent 60%, --eve-static-white)
   * and the pill background is color-mix(maxAccent 16%, transparent) composited
   * over the composer surface — i.e. 0.16*accent + 0.84*surface.
   */
  const LIGHT_ACCENT_SHARE = 0.7;
  const DARK_ACCENT_SHARE = 0.6;
  const PILL_TINT = 0.16;
  const SHELL_TEXT_LIGHT = '#111827';
  const STATIC_WHITE = '#ffffff';
  const SURFACE_LIGHT = '#ffffff';
  const SURFACE_DARK = '#171a1e';

  type Rgb = [number, number, number];
  const parse = (hex: string): Rgb => {
    const h = hex.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  };
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = (rgb: Rgb): number =>
    0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const contrast = (a: Rgb, b: Rgb): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const mix = (a: Rgb, b: Rgb, share: number): Rgb =>
    a.map((v, i) => Math.round(v * share + b[i] * (1 - share))) as Rgb;

  /** Every accent the product actually ships, read from the source of truth. */
  const shippedAccents = Object.entries(EVE_ACCENTS).flatMap(([name, pair]) => [
    { name: `${name}/light`, base: pair.light.base, theme: 'light' as const },
    { name: `${name}/dark`, base: pair.dark.base, theme: 'dark' as const },
  ]);

  function labelContrast(accentHex: string, theme: 'light' | 'dark'): number {
    const accent = parse(accentHex);
    const maxAccent =
      theme === 'light'
        ? mix(accent, parse(SHELL_TEXT_LIGHT), LIGHT_ACCENT_SHARE)
        : mix(accent, parse(STATIC_WHITE), DARK_ACCENT_SHARE);
    const surface = parse(theme === 'light' ? SURFACE_LIGHT : SURFACE_DARK);
    const pillBackground = mix(maxAccent, surface, PILL_TINT);
    return contrast(maxAccent, pillBackground);
  }

  it('the CSS uses exactly the lightness mixes this contrast model assumes', () => {
    // If the stylesheet drifts from the model, the numbers below stop meaning
    // anything — so the model is pinned to the source, not assumed.
    expect(css).toContain(
      `--eve-max-accent: color-mix(in srgb, var(--eve-accent, var(--primary)) ${LIGHT_ACCENT_SHARE * 100}%, var(--eve-shell-text))`
    );
    expect(css).toContain(
      `--eve-max-accent: color-mix(in srgb, var(--eve-accent, var(--primary)) ${DARK_ACCENT_SHARE * 100}%, var(--eve-static-white))`
    );
    // The pill tint lives in the send-bar stylesheet, not the token layer.
    const sendBar = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/renderer/components/chat/UnifiedSendBar.css'),
      'utf-8'
    );
    expect(sendBar).toContain(`color-mix(in srgb, var(--eve-max-accent) ${PILL_TINT * 100}%, transparent)`);
  });

  it.each(shippedAccents.map((a) => [a.name, a] as const))(
    '%s: the MAX label clears WCAG AA (4.5:1) on the engaged pill',
    (_name, accent) => {
      const ratio = labelContrast(accent.base, accent.theme);
      expect(ratio, `${accent.name} label contrast ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  );

  it('REGRESSION: using the raw accent (the shipped defect) would FAIL in dark', () => {
    // Guards the fix itself. Before the lightness adjustment the label used the
    // accent verbatim; this reproduces that and asserts it is genuinely below AA,
    // so the assertions above cannot pass for a trivial reason.
    const rawDark = (() => {
      const accent = parse(EVE_ACCENTS.blue.dark.base);
      const pill = mix(accent, parse(SURFACE_DARK), PILL_TINT);
      return contrast(accent, pill);
    })();
    expect(rawDark).toBeLessThan(4.5);
    // ...and the adjusted value clears it.
    expect(labelContrast(EVE_ACCENTS.blue.dark.base, 'dark')).toBeGreaterThanOrEqual(4.5);
  });

  it('the accent stays the SAME COLOUR FAMILY — a lightness change, not a new hue', () => {
    // A "fix" that swapped hue would pass contrast and fail the brief.
    for (const accent of shippedAccents) {
      const base = parse(accent.base);
      const adjusted =
        accent.theme === 'light'
          ? mix(base, parse(SHELL_TEXT_LIGHT), LIGHT_ACCENT_SHARE)
          : mix(base, parse(STATIC_WHITE), DARK_ACCENT_SHARE);
      // Channel ORDER (which component dominates) is preserved by a mix toward
      // a neutral, so the hue family survives.
      const order = (rgb: number[]): string =>
        rgb
          .map((v, i) => [v, i] as const)
          .sort((x, y) => y[0] - x[0])
          .map(([, i]) => i)
          .join('');
      expect(order([...adjusted]), `${accent.name} hue order changed`).toBe(order([...base]));
    }
  });
});

describe('MAX composer state — reduced motion keeps the state, drops the motion', () => {
  const REDUCED_EFFECTS_SELECTOR = ":root[data-eve-reduced-effects='true']";

  it('honours the app-level reduced-effects flag', () => {
    const rule = css.match(
      new RegExp(
        `${REDUCED_EFFECTS_SELECTOR.replace(/[[\]'=]/g, '\\$&')} \\.eve-composer-surface\\[data-eve-max='true'\\][^{]*\\{[^}]*\\}`
      )
    );
    expect(rule).not.toBeNull();
    expect(rule![0]).toMatch(/animation:\s*none/);
    expect(rule![0]).toMatch(/transition:\s*none/);
    // The STATE must survive: the block must NOT unset the colour/border vars.
    expect(rule![0]).not.toMatch(/--eve-spotlight-color/);
    expect(rule![0]).not.toMatch(/--eve-composer-border/);
  });

  it('honours the OS-level prefers-reduced-motion media query too', () => {
    const mediaStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(mediaStart).toBeGreaterThan(-1);
    // Take a generous window; the block is long but the MAX rules live inside it.
    const block = css.slice(mediaStart, mediaStart + 4000);
    const maxRuleIndex = block.indexOf(".eve-composer-surface[data-eve-max='true']");
    expect(maxRuleIndex).toBeGreaterThan(-1);
    const maxRules = block.slice(maxRuleIndex, maxRuleIndex + 500);
    expect(maxRules).toMatch(/animation:\s*none/);
    expect(maxRules).toMatch(/transition:\s*none/);
    expect(maxRules).not.toMatch(/--eve-spotlight-color/);
  });

  it('keeps the MAX hairline VISIBLE under reduced motion (opacity is not zeroed)', () => {
    const reducedOpacityRules = css.match(
      /\.eve-composer-surface\[data-eve-max='true'\]::before\s*\{\s*opacity:\s*([0-9.]+);/g
    );
    expect(reducedOpacityRules).not.toBeNull();
    for (const rule of reducedOpacityRules!) {
      const value = Number(rule.match(/opacity:\s*([0-9.]+)/)![1]);
      expect(value).toBeGreaterThan(0);
    }
  });
});
