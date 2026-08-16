import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const arcoOverridePath = path.resolve(process.cwd(), 'packages/desktop/src/renderer/styles/arco-override.css');
const presetDir = path.resolve(
  process.cwd(),
  'packages/desktop/src/renderer/pages/settings/AppearanceSettings/presets'
);

/**
 * Declarations of the single rule that starts at `selectorHead`. Overlay rules
 * repeat the same token chain for several surfaces, so an unscoped assertion
 * would still pass while the rule under test drifted to a fixed colour.
 */
const ruleDeclarations = (css: string, selectorHead: string): string => {
  const start = css.indexOf(selectorHead);
  if (start === -1) return '';
  return css.slice(start, css.indexOf('\n}', start));
};

/** A literal colour or gradient here would override the token above it. */
const FIXED_BACKGROUND = /background:\s*(?:#|rgb|hsl|[a-z-]*gradient)/;

describe('arco tooltip and popover overlay styles', () => {
  it('defines shared light and dark overlay tokens for tooltip-like surfaces', () => {
    const css = fs.readFileSync(arcoOverridePath, 'utf8');

    expect(css).toContain('--aion-overlay-bg: var(--eve-overlay-surface-solid, #ffffff);');
    expect(css).toContain('--aion-overlay-text: var(--eve-overlay-text, #1d2129);');
    expect(css).toContain("body[arco-theme='dark'] {");
    expect(css).toContain('--aion-overlay-bg: var(--eve-overlay-surface-solid, #0e0e0e);');
    expect(css).toContain('--aion-overlay-text: var(--eve-overlay-text, #f2f3f5);');
  });

  it('applies the shared overlay tokens to tooltip, popover, and popconfirm surfaces', () => {
    const css = fs.readFileSync(arcoOverridePath, 'utf8');
    const overlaySurface = ruleDeclarations(css, 'html body .arco-tooltip-content,');
    const opaqueFallback = ruleDeclarations(css, ":root[data-eve-reduced-effects='true'] body .arco-tooltip-content,");

    expect(css).toContain('.arco-tooltip-content,');
    expect(css).toContain('.arco-popover-content,');
    expect(css).toContain('.arco-popconfirm-content {');

    // The --eve-* alias owns the overlay material; --glass-* and --aion-* remain
    // ordered fallbacks. Pinning the whole chain keeps these surfaces on the
    // shared token instead of a per-surface colour.
    expect(overlaySurface).toContain(
      'background: var(--eve-overlay-surface, var(--glass-overlay-bg, var(--aion-overlay-bg))) !important;'
    );
    expect(overlaySurface).toContain('color: var(--aion-overlay-text) !important;');
    expect(overlaySurface).toContain(
      'border: 1px solid var(--eve-overlay-border, var(--glass-overlay-border, var(--aion-overlay-border))) !important;'
    );
    expect(overlaySurface).toContain(
      '-webkit-backdrop-filter: var(--eve-overlay-filter, var(--glass-overlay-filter, blur(18px) saturate(125%)));'
    );
    expect(overlaySurface).not.toMatch(FIXED_BACKGROUND);

    // Reduced effects drop the blur, so the opaque twin of the same token has to
    // carry the surface rather than a hardcoded panel colour.
    expect(opaqueFallback).toContain(
      'background: var(--eve-overlay-surface-solid, var(--glass-overlay-bg-solid, var(--aion-overlay-bg))) !important;'
    );
    expect(opaqueFallback).not.toMatch(FIXED_BACKGROUND);

    expect(css).toContain('.arco-trigger-arrow.arco-tooltip-arrow,');
    expect(css).toContain('.arco-popover-arrow.arco-trigger-arrow,');
    expect(css).toContain('.arco-popconfirm-arrow.arco-trigger-arrow {');
  });

  it('defines a dark-mode override selector that can beat preset-specific tooltip rules', () => {
    const css = fs.readFileSync(arcoOverridePath, 'utf8');

    expect(css).toContain("html[data-theme='dark'] body .arco-tooltip-content,");
    expect(css).toContain("html[data-theme='dark'] body .arco-popover-content,");
    expect(css).toContain("html[data-theme='dark'] body .arco-popconfirm-content,");
    expect(css).toContain("body[arco-theme='dark'] .arco-popconfirm-content {");
  });

  it('does not skin nested popover wrappers as a second surface', () => {
    const css = fs.readFileSync(arcoOverridePath, 'utf8');

    expect(css).not.toContain('.arco-popover-inner,');
    expect(css).not.toContain('.arco-tooltip-inner,');
  });

  it('keeps decorative preset css from re-skinning tooltip surfaces', () => {
    const presetFiles = ['retro-windows.css', 'misaka-mikoto.css', 'discourse-horizon.css', 'hello-kitty.css'];

    for (const file of presetFiles) {
      const css = fs.readFileSync(path.join(presetDir, file), 'utf8');
      expect(css).not.toContain('.arco-tooltip-inner *');
      expect(css).not.toContain('.arco-popover-inner *');
      expect(css).not.toContain('.arco-popover-content *');
      expect(css).not.toContain("[data-theme='dark'] .arco-tooltip-inner");
      expect(css).not.toContain("[data-theme='dark'] .arco-popover-inner");
      expect(css).not.toContain("[data-theme='dark'] .arco-popover-content");
    }

    const retromaNocturne = fs.readFileSync(path.join(presetDir, 'retroma-nocturne-parchment.css'), 'utf8');
    const retromaObsidianDark = fs.readFileSync(path.join(presetDir, 'retroma-obsidian-book-2-1-dark.css'), 'utf8');

    expect(retromaNocturne).not.toContain('.arco-popover-content,');
    expect(retromaObsidianDark).not.toContain("[data-theme='dark'] .arco-popover-content,");
  });
});
