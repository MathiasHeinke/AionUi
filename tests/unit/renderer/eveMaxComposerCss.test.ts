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
    // The accent comes from the token layer, and the border is mixed from it.
    expect(css).toMatch(/--eve-max-accent:\s*var\(--eve-accent/);
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
