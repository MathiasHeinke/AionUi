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

/** CSS comments legitimately mention selector names; only real rules count. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Custom properties DECLARED anywhere in the loaded stylesheets. */
function declaredCustomProperties(source: string): Set<string> {
  return new Set((source.match(/(^|[;{\s])(--[a-z0-9-]+)\s*:/gi) ?? []).map((m) => m.match(/--[a-z0-9-]+/i)![0]));
}

// ── SHARED COLOUR MODEL ─────────────────────────────────────────────────────
// Module scope on purpose: the contrast suite and the focus-ring suite must use
// the SAME model. Two private copies would be free to drift, and a drifted model
// is how the flat-token version stayed green while the screen failed.

type Rgb = [number, number, number];
const parse = (hex: string): Rgb => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
};
const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const luminance = (rgb: Rgb | readonly number[]): number =>
  0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
const contrast = (a: Rgb | readonly number[], b: Rgb | readonly number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const mix = (a: Rgb, b: Rgb, share: number): Rgb => a.map((v, i) => Math.round(v * share + b[i] * (1 - share))) as Rgb;
/** Composite a translucent colour over an opaque background (what the GPU does). */
const over = (fg: Rgb, alpha: number, bg: readonly number[]): Rgb =>
  fg.map((v, i) => v * alpha + bg[i] * (1 - alpha)) as Rgb;

const LIGHT_ACCENT_SHARE = 0.7;
const DARK_ACCENT_SHARE = 0.44;
const SHELL_TEXT_LIGHT = '#111827';
const STATIC_WHITE = '#ffffff';

/** Effective COMPOSITED composer backgrounds (Electron measurement, see the suite). */
const COMPOSER_BACKGROUND = {
  light: [250, 250, 251] as const,
  dark: [41, 41, 41] as const,
};

function maxAccentFor(accentHex: string, theme: 'light' | 'dark'): Rgb {
  const accent = parse(accentHex);
  return theme === 'light'
    ? mix(accent, parse(SHELL_TEXT_LIGHT), LIGHT_ACCENT_SHARE)
    : mix(accent, parse(STATIC_WHITE), DARK_ACCENT_SHARE);
}

/** Every accent the product actually ships, read from the source of truth. */
const shippedAccents = Object.entries(EVE_ACCENTS).flatMap(([name, pair]) => [
  { name: `${name}/light`, base: pair.light.base, theme: 'light' as const },
  { name: `${name}/dark`, base: pair.dark.base, theme: 'dark' as const },
]);

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
  const PILL_TINT = 0.16;

  /**
   * THE BAR (Founder, clarified): AA 4.5:1 is the FLOOR for normal enabled text,
   * measured in the real composited surface. ~5:1 is the AIM where the existing
   * palette permits it. AAA 7:1 is explicitly NOT a mandate — we report it so the
   * trade-off is visible, and we do not redesign to force it.
   */
  const AA_FLOOR = 4.5;
  const COMFORT_AIM = 5.0;
  const AAA_REFERENCE = 7.0;

  /** Neutral-label alphas, kept in lockstep with UnifiedSendBar.css. */
  const NEUTRAL_ALPHA = { available: 0.68, locked: 0.64, busyInactive: 0.68 };
  /** Background tints. */
  const TINT = { active: 0.16, busyActive: 0.12, busyNeutral: 0.05 };

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
  /** Composite a translucent colour over an opaque background (what the GPU does). */
  const over = (fg: Rgb, alpha: number, bg: readonly number[]): Rgb =>
    fg.map((v, i) => v * alpha + bg[i] * (1 - alpha)) as Rgb;

  /**
   * The real stack: label colour vs the 16% accent TINT COMPOSITED OVER the
   * effective (translucent) composer background — not over a flat token.
   */
  function labelContrast(accentHex: string, theme: 'light' | 'dark'): number {
    const label = maxAccentFor(accentHex, theme);
    const pillBackground = over(label, PILL_TINT, COMPOSER_BACKGROUND[theme]);
    return contrast(label, pillBackground);
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
    `%s: the ACTIVE MAX label clears the ${COMFORT_AIM}:1 aim`,
    (_name, accent) => {
      const ratio = labelContrast(accent.base, accent.theme);
      expect(ratio, `${accent.name} label contrast ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(COMFORT_AIM);
    }
  );

  /**
   * EVERY state, not just the active one. Restricting the model to `active` is
   * how a 2.99:1 locked label shipped: the state nobody measured was the state
   * that failed. `locked` and `available` are ENABLED controls and owe the full
   * AA floor; the busy/disabled states must stay legible too.
   */
  function stateContrasts(accentHex: string, theme: 'light' | 'dark'): Record<string, number> {
    const label = maxAccentFor(accentHex, theme);
    const neutral = parse(theme === 'light' ? SHELL_TEXT_LIGHT : '#f7f8fa');
    const composer = COMPOSER_BACKGROUND[theme];
    const busyNeutralBg = over(neutral, TINT.busyNeutral, composer);
    return {
      active: contrast(label, over(label, TINT.active, composer)),
      'active+busy': contrast(label, over(label, TINT.busyActive, composer)),
      available: contrast(over(neutral, NEUTRAL_ALPHA.available, composer), composer),
      locked: contrast(over(neutral, NEUTRAL_ALPHA.locked, composer), composer),
      'busy (inactive)': contrast(over(neutral, NEUTRAL_ALPHA.busyInactive, busyNeutralBg), busyNeutralBg),
    };
  }

  it('EVERY pill state clears the AA floor in EVERY shipped accent/theme', () => {
    const failures: string[] = [];
    for (const accent of shippedAccents) {
      for (const [state, ratio] of Object.entries(stateContrasts(accent.base, accent.theme))) {
        if (ratio < AA_FLOOR) failures.push(`${accent.name} ${state} = ${ratio.toFixed(2)}:1`);
      }
    }
    expect(failures, `states under AA ${AA_FLOOR}:1`).toEqual([]);
  });

  it('REGRESSION: the 46% locked label that shipped would FAIL the AA floor', () => {
    // The state that was never modelled. Pins the fix so it cannot silently
    // revert, and proves the suite above is not passing for a trivial reason.
    const neutral = parse(SHELL_TEXT_LIGHT);
    const old = contrast(over(neutral, 0.46, COMPOSER_BACKGROUND.light), COMPOSER_BACKGROUND.light);
    expect(old).toBeLessThan(AA_FLOOR);
    const fixed = contrast(over(neutral, NEUTRAL_ALPHA.locked, COMPOSER_BACKGROUND.light), COMPOSER_BACKGROUND.light);
    expect(fixed).toBeGreaterThanOrEqual(COMFORT_AIM);
  });

  it('the neutral alphas match UnifiedSendBar.css — the model cannot drift from what ships', () => {
    const sendBar = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/renderer/components/chat/UnifiedSendBar.css'),
      'utf-8'
    );
    expect(sendBar).toContain(
      `[data-locked='true'] {\n  color: color-mix(in srgb, var(--eve-shell-text, var(--color-text-1)) ${NEUTRAL_ALPHA.locked * 100}%, transparent) !important;`
    );
    expect(sendBar).toContain(
      `color-mix(in srgb, var(--eve-shell-text, var(--color-text-1)) ${NEUTRAL_ALPHA.busyInactive * 100}%, transparent) !important`
    );
    expect(sendBar).toContain(`color-mix(in srgb, var(--eve-max-accent) ${TINT.busyActive * 100}%, transparent)`);
  });

  it('DISABLED/BUSY stays subordinate WITHOUT paying for it in legibility', () => {
    // The tension the Founder named: a disabled control that is too vivid reads
    // as engaged. Subordination is carried by the BORDER and the TINT — the
    // disabled rule drops the border and weakens the tint — so the label can keep
    // full contrast. Dimming the label instead measured 4.88:1, i.e. buying
    // hierarchy by moving text toward the floor.
    const sendBar = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/renderer/components/chat/UnifiedSendBar.css'),
      'utf-8'
    );
    // Active has a visible border; the disabled state removes it.
    expect(sendBar).toMatch(/\[data-active='true'\]\s*\{[^}]*border-color:\s*color-mix/s);
    expect(sendBar).toMatch(/\[disabled\][^{]*\{[^}]*border-color:\s*transparent/s);
    // And the busy tint is strictly weaker than the active tint.
    expect(TINT.busyActive).toBeLessThan(TINT.active);

    // A busy+INACTIVE control must carry NO accent at all — that is the one that
    // would be lying if it looked engaged.
    for (const accent of shippedAccents) {
      const s = stateContrasts(accent.base, accent.theme);
      expect(s['busy (inactive)']).toBeGreaterThanOrEqual(AA_FLOOR);
    }
  });

  it('reports AAA (7:1) for the record WITHOUT gating on it', () => {
    // AAA is explicitly not the mandate. This records where we land so the
    // trade-off is visible instead of an AA pass being presented as AAA.
    const aaaPassing = shippedAccents.filter((a) => labelContrast(a.base, a.theme) >= AAA_REFERENCE);
    // Documented reality: only the lowest-chroma accent reaches AAA on the
    // active pill. Forcing the rest there would bleach the accent.
    expect(aaaPassing.length).toBeLessThan(shippedAccents.length);
    expect(AAA_REFERENCE).toBe(7.0);
  });

  it('the model REPRODUCES the independent Electron measurement (it is calibrated, not assumed)', () => {
    // A contrast model that cannot reproduce a real measurement is a guess. The
    // previous flat-token model predicted 4.73 where Electron measured 4.33; this
    // one lands on 4.34 for the SAME inputs (blue/dark at the old 60% share),
    // which is what earns it the right to gate the new value.
    const oldDarkLabel = mix(parse(EVE_ACCENTS.blue.dark.base), parse(STATIC_WHITE), 0.6);
    const oldDarkRatio = contrast(oldDarkLabel, over(oldDarkLabel, PILL_TINT, COMPOSER_BACKGROUND.dark));
    expect(oldDarkRatio).toBeGreaterThan(4.2);
    expect(oldDarkRatio).toBeLessThan(4.5); // measured 4.33 — below AA, as reported

    // And light, where the measurement was 5.85: the model must be in range and
    // must NOT be optimistic.
    const lightRatio = labelContrast(EVE_ACCENTS.blue.light.base, 'light');
    expect(lightRatio).toBeGreaterThan(5.0);
    expect(lightRatio).toBeLessThanOrEqual(5.9);
  });

  it('REGRESSION: the previous 60% dark share would FAIL this gate', () => {
    // Guards the fix itself: the assertions above cannot be passing for a trivial
    // reason, because the value they replaced is genuinely below the bar.
    const oldDarkLabel = mix(parse(EVE_ACCENTS.blue.dark.base), parse(STATIC_WHITE), 0.6);
    const oldRatio = contrast(oldDarkLabel, over(oldDarkLabel, PILL_TINT, COMPOSER_BACKGROUND.dark));
    expect(oldRatio).toBeLessThan(COMFORT_AIM);
    expect(labelContrast(EVE_ACCENTS.blue.dark.base, 'dark')).toBeGreaterThanOrEqual(COMFORT_AIM);
  });

  it('the pill background is modelled as a COMPOSITE, never as a flat token', () => {
    // The specific modelling error, pinned. Compositing 16% of a LIGHT label over
    // a dark composer must yield a LIGHTER background than the composer alone —
    // if this ever equals the flat token again, the model has regressed to the
    // optimistic version.
    const label = maxAccentFor(EVE_ACCENTS.blue.dark.base, 'dark');
    const composited = over(label, PILL_TINT, COMPOSER_BACKGROUND.dark);
    expect(luminance(composited)).toBeGreaterThan(luminance([...COMPOSER_BACKGROUND.dark] as Rgb));
    // ...and the effective dark composer is lighter than the raw surface token,
    // which is the fact the flat model missed.
    expect(luminance([...COMPOSER_BACKGROUND.dark] as Rgb)).toBeGreaterThan(luminance(parse('#171a1e')));
  });

  it('the accent stays the SAME COLOUR FAMILY — a lightness change, not a new hue', () => {
    // A "fix" that swapped hue would pass contrast and fail the brief.
    for (const accent of shippedAccents) {
      const base = parse(accent.base);
      const adjusted = maxAccentFor(accent.base, accent.theme);
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

describe('MAX pill keyboard focus — WCAG 2.4.7 (D1)', () => {
  const sendBarCss = fs.readFileSync(
    path.resolve(__dirname, '../../../packages/desktop/src/renderer/components/chat/UnifiedSendBar.css'),
    'utf-8'
  );

  /** CSS specificity (ids, classes+attrs+pseudo-classes, elements) for a simple selector. */
  function specificity(selector: string): [number, number, number] {
    const cleaned = selector.replace(/::[a-z-]+/g, '');
    const ids = (cleaned.match(/#[\w-]+/g) ?? []).length;
    const classes = (cleaned.match(/\.[\w-]+/g) ?? []).length;
    const attrs = (cleaned.match(/\[[^\]]+\]/g) ?? []).length;
    const pseudos = (cleaned.match(/:(?!:)[a-z-]+(\([^)]*\))?/g) ?? []).length;
    return [ids, classes + attrs + pseudos, 0];
  }
  const cmp = (a: [number, number, number], b: [number, number, number]): number =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

  /** Rules (selector + body + source position) whose selector mentions the MAX pill. */
  const rules = [...stripCssComments(sendBarCss).matchAll(/([^{}@]*eve-max-toggle[^{}]*)\{([^}]*)\}/g)].map((m) => ({
    selectors: m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    body: m[2],
    index: m.index ?? 0,
  }));

  it('a focus-visible rule exists AND declares a visible indicator', () => {
    const focusRules = rules.filter((r) => r.selectors.some((s) => s.includes(':focus-visible')));
    expect(focusRules.length).toBeGreaterThan(0);
    const ringRule = focusRules.find((r) => /box-shadow:\s*0 0 0 2px/.test(r.body));
    expect(ringRule, 'no focus RING is declared').toBeDefined();
    // Not `none`, not a no-op.
    expect(ringRule!.body).not.toMatch(/box-shadow:\s*none/);
  });

  it.each([
    ["data-active='true'", "[data-active='true']"],
    ["data-active='false'", ''],
  ])('the focus ring actually WINS over the %s state rule (order + specificity)', (_label, stateAttr) => {
    // THE POINT: a rule that exists but loses is invisible, which is exactly how this
    // shipped. Existence is not enough — it has to beat whatever paints that state.
    const ringRule = rules.find((r) => /box-shadow:\s*0 0 0 2px/.test(r.body))!;
    const ringSelector = ringRule.selectors.find((s) =>
      stateAttr ? s.includes(stateAttr) && s.includes(':focus-visible') : s.includes(':focus-visible')
    );
    expect(ringSelector, `no focus selector covers ${_label}`).toBeDefined();

    // Every rule that paints this state and could contest box-shadow.
    const contenders = rules.filter(
      (r) =>
        r !== ringRule &&
        r.selectors.some((s) => (stateAttr ? s.includes(stateAttr) : true) && !s.includes(':focus-visible')) &&
        /box-shadow:/.test(r.body)
    );

    for (const rival of contenders) {
      const rivalSelector = rival.selectors.find((s) => (stateAttr ? s.includes(stateAttr) : true))!;
      const ringSpec = specificity(ringSelector!);
      const rivalSpec = specificity(rivalSelector);
      const ringWins = cmp(ringSpec, rivalSpec) > 0 || (cmp(ringSpec, rivalSpec) === 0 && ringRule.index > rival.index);
      expect(
        ringWins,
        `focus ring [${ringSpec}] @${ringRule.index} loses to "${rivalSelector}" [${rivalSpec}] @${rival.index}`
      ).toBe(true);
    }
  });

  it('REGRESSION: the equal-specificity ordering that caused D1 is pinned', () => {
    // The measured cause: the hover/focus rule and the [data-active] rule are BOTH
    // (0,4,0) with !important, and [data-active] was declared later, so focus lost.
    // If the ring is ever moved ABOVE the state rules, this turns red.
    const ringRule = rules.find((r) => /box-shadow:\s*0 0 0 2px/.test(r.body))!;
    const activeRule = rules.find(
      (r) =>
        r.selectors.some((s) => s.includes("[data-active='true']") && !s.includes(':')) && /background:/.test(r.body)
    )!;
    expect(activeRule).toBeDefined();
    expect(ringRule.index).toBeGreaterThan(activeRule.index);
  });

  it('the focus ring clears WCAG 1.4.11 (3:1 non-text) in EVERY shipped accent/theme', () => {
    // The first proposed value was 34%, which measured 1.75:1 — a focus ring that
    // exists and cannot be seen is the same defect wearing a different hat.
    const RING_ALPHA = 0.8;
    expect(sendBarCss).toContain(
      `box-shadow: 0 0 0 2px color-mix(in srgb, var(--eve-max-accent) ${RING_ALPHA * 100}%, transparent)`
    );
    const failures: string[] = [];
    for (const accent of shippedAccents) {
      const ring = over(maxAccentFor(accent.base, accent.theme), RING_ALPHA, COMPOSER_BACKGROUND[accent.theme]);
      const ratio = contrast(ring, [...COMPOSER_BACKGROUND[accent.theme]] as Rgb);
      if (ratio < 3.0) failures.push(`${accent.name} ring ${ratio.toFixed(2)}:1`);
    }
    expect(failures, 'focus rings under the 3:1 non-text floor').toEqual([]);
  });

  it('REGRESSION: the 34% ring first proposed would FAIL the non-text floor', () => {
    const ring = over(maxAccentFor(EVE_ACCENTS.blue.light.base, 'light'), 0.34, COMPOSER_BACKGROUND.light);
    expect(contrast(ring, [...COMPOSER_BACKGROUND.light] as Rgb)).toBeLessThan(3.0);
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
