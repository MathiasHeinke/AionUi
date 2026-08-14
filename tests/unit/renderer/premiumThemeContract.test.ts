/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string): string => readFileSync(resolve(process.cwd(), relativePath), 'utf8');
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '');

const visualCss = withoutComments(read('packages/desktop/src/renderer/styles/themes/command-eve-visual.css'));
const baseCss = withoutComments(read('packages/desktop/src/renderer/styles/themes/base.css'));
const arcoCss = withoutComments(read('packages/desktop/src/renderer/styles/arco-override.css'));
const loginCss = withoutComments(read('packages/desktop/src/renderer/pages/login/LoginPage.css'));
const registrationCss = withoutComments(
  read('packages/desktop/src/renderer/pages/registrationGate/RegistrationGatePage.css')
);

const longMenuSurfaces = [
  {
    name: 'Arco overlay families',
    source: arcoCss,
    anchor: 'html body .arco-dropdown-menu,',
  },
  {
    name: 'work-product menu',
    source: withoutComments(read('packages/desktop/src/renderer/components/chat/WorkProductModeSelector.module.css')),
    anchor: '.menu {',
  },
  {
    name: 'authority menu',
    source: withoutComments(read('packages/desktop/src/renderer/components/chat/ComposerContextDeck.module.css')),
    anchor: '.authorityMenu {',
  },
  {
    name: 'workspace menu',
    source: withoutComments(
      read('packages/desktop/src/renderer/components/workspace/WorkspaceContextControl.module.css')
    ),
    anchor: '.menu {',
  },
  {
    name: 'workbench launcher menu',
    source: withoutComments(
      read('packages/desktop/src/renderer/components/layout/Titlebar/ShellWorkbenchTabs.module.css')
    ),
    anchor: '.launcherMenu {',
  },
];

const themePresetCss = [
  'hello-kitty.css',
  'misaka-mikoto.css',
  'retroma-y2k.css',
  'discourse-horizon.css',
  'retroma-obsidian-book.css',
  'glittering-input-field.css',
].map((file) => ({
  file,
  source: withoutComments(read(`packages/desktop/src/renderer/pages/settings/AppearanceSettings/presets/${file}`)),
}));

function block(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  expect(start, `missing CSS contract anchor: ${anchor}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  expect(open, `missing opening brace after: ${anchor}`).toBeGreaterThan(start);

  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }

  throw new Error(`unterminated CSS block: ${anchor}`);
}

function declaration(source: string, token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*:\\s*([^;]+);`));
  expect(match, `missing token declaration: ${token}`).not.toBeNull();
  return (match as RegExpMatchArray)[1].trim();
}

describe('Command EVE premium semantic token foundation', () => {
  const light = block(visualCss, ":root,\n[data-color-scheme='default']");
  const dark = block(visualCss, ":root[data-theme='dark'],");

  it('keeps action, selection and focus on the blue action lane', () => {
    expect(declaration(light, '--eve-action')).toBe('var(--eve-accent)');
    expect(declaration(light, '--eve-interaction-selected-indicator')).toBe('var(--eve-accent)');
    expect(declaration(light, '--eve-control-border-focus')).toBe('var(--eve-focus-ring)');
    expect(declaration(light, '--eve-focus-ring')).toContain('var(--primary)');
  });

  it('does not leak EVE orange into controls, interaction, focus or scrollbars', () => {
    const protectedDeclarations = [
      ...visualCss.matchAll(/(--eve-(?:action|control|interaction|focus|scrollbar)[\w-]*)\s*:\s*([^;]+);/g),
    ];
    expect(protectedDeclarations.length).toBeGreaterThan(20);

    for (const [, token, value] of protectedDeclarations) {
      expect(value, `${token} must not consume the orange brand lane`).not.toMatch(/--eve-brand-(?:logo|ui|soft)/);
    }
  });

  it('defines theme-aware control and scrollbar roles for both light and dark', () => {
    for (const token of [
      '--eve-control-surface',
      '--eve-control-surface-hover',
      '--eve-control-surface-selected',
      '--eve-control-surface-disabled',
      '--eve-control-border',
      '--eve-control-border-hover',
      '--eve-scrollbar-thumb',
      '--eve-scrollbar-thumb-hover',
      '--eve-scrollbar-thumb-active',
    ]) {
      expect(declaration(light, token), `${token} missing from the light contract`).toBeTruthy();
      expect(declaration(dark, token), `${token} missing from the dark contract`).toBeTruthy();
    }
  });

  it('keeps every scrollbar color neutral and independent of action/brand tokens', () => {
    const scrollbarDeclarations = [...visualCss.matchAll(/(--eve-scrollbar-[\w-]+)\s*:\s*([^;]+);/g)];
    expect(scrollbarDeclarations.length).toBeGreaterThanOrEqual(9);

    for (const [, token, value] of scrollbarDeclarations) {
      expect(value, `${token} must remain neutral`).not.toMatch(/--eve-(?:accent|action|brand)|--primary/);
    }
  });
});

describe('premium scrollbar consumption', () => {
  const scrollbarSection = baseCss.slice(
    baseCss.indexOf('* {\n  scrollbar-color:'),
    baseCss.indexOf('.scrollbar-hide')
  );

  it('covers Firefox and WebKit with the same thin neutral tokens', () => {
    expect(scrollbarSection).toContain('scrollbar-color: var(--eve-scrollbar-thumb) var(--eve-scrollbar-track)');
    expect(scrollbarSection).toContain('scrollbar-width: thin');
    expect(block(baseCss, '::-webkit-scrollbar {')).toMatch(
      /width:\s*var\(--eve-scrollbar-size\);[\s\S]*height:\s*var\(--eve-scrollbar-size\)/
    );
    expect(block(baseCss, '::-webkit-scrollbar-thumb {')).toContain('background: var(--eve-scrollbar-thumb)');
    expect(block(baseCss, '::-webkit-scrollbar-thumb:hover {')).toContain(
      'background: var(--eve-scrollbar-thumb-hover)'
    );
    expect(block(baseCss, '::-webkit-scrollbar-thumb:active {')).toContain(
      'background: var(--eve-scrollbar-thumb-active)'
    );
  });

  it('contains no literal or accent-colored scrollbar state', () => {
    expect(scrollbarSection).not.toMatch(/rgba?\(|#[0-9a-f]{3,8}\b/i);
    expect(scrollbarSection).not.toMatch(/--eve-(?:accent|action|brand)|--primary/);
    expect(baseCss).not.toMatch(/\[data-theme='dark'\][^{]*::-webkit-scrollbar-thumb/);
  });
});

describe('premium overlay and interaction adapters', () => {
  it('aligns both icon systems to one ambient baseline', () => {
    const iconBlock = block(arcoCss, 'html body :where(.i-icon, .arco-icon) {');
    expect(iconBlock).toContain('display: inline-flex');
    expect(iconBlock).toContain('color: inherit');
    expect(iconBlock).toContain('align-self: center');
    expect(iconBlock).toContain('vertical-align: -0.125em');
  });

  it('routes button, switch, checkbox, radio and tab states through semantic action tokens', () => {
    for (const selector of [
      'html body .arco-btn-secondary:not(.arco-btn-disabled)',
      'html body .arco-btn-primary:not(.arco-btn-disabled)',
      'html body .arco-btn-disabled,',
      'html body .arco-switch-checked,',
      'html body .arco-tabs-header-ink {',
    ]) {
      expect(arcoCss, `missing premium primitive adapter: ${selector}`).toContain(selector);
    }
    expect(block(arcoCss, 'html body .arco-btn-primary:not(.arco-btn-disabled) {')).toContain(
      'background: var(--eve-action)'
    );
  });

  it('covers native controls and custom menu roles without stealing their layout', () => {
    expect(arcoCss).toContain('button:not(.arco-btn)');
    expect(arcoCss).toContain("[role='menuitem']");
    expect(arcoCss).toContain("[role='option']");
    expect(arcoCss).toContain('input:not(.arco-input)');
    expect(arcoCss).toContain('outline: 2px solid var(--eve-focus-ring) !important');
    expect(arcoCss).toContain('opacity: var(--eve-interaction-disabled-opacity, 0.5)');
  });

  it('routes every Arco overlay family through the semantic overlay material', () => {
    for (const token of [
      '--eve-overlay-surface',
      '--eve-overlay-surface-solid',
      '--eve-overlay-border',
      '--eve-overlay-shadow',
      '--eve-overlay-filter',
      '--eve-overlay-scrim',
    ]) {
      expect(arcoCss, `Arco no longer consumes ${token}`).toContain(`var(${token}`);
    }
  });

  it('uses the shared hover, pressed, selected and disabled state ladder', () => {
    for (const token of [
      '--eve-interaction-hover-bg',
      '--eve-interaction-pressed-bg',
      '--eve-interaction-selected-bg',
      '--eve-control-text-disabled',
      '--eve-interaction-disabled-opacity',
    ]) {
      expect(arcoCss, `Arco no longer consumes ${token}`).toContain(`var(${token}`);
    }
  });

  it('has solid overlay fallbacks for user preference and unsupported blur', () => {
    expect(block(arcoCss, '@media (prefers-reduced-transparency: reduce)')).toContain(
      'var(--eve-overlay-surface-solid'
    );
    expect(
      block(arcoCss, '@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px)))')
    ).toContain('var(--eve-overlay-surface-solid');
    expect(block(arcoCss, ":root[data-eve-reduced-effects='true'] body .arco-tooltip-content,")).toContain(
      'var(--eve-overlay-surface-solid'
    );
  });

  it('keeps every long overlay and custom menu bounded, scrollable and neutral', () => {
    for (const surface of longMenuSurfaces) {
      const surfaceBlock = block(surface.source, surface.anchor);
      expect(surfaceBlock, `${surface.name} lost its viewport height bound`).toMatch(/max-height:\s*min\(/);
      expect(surfaceBlock, `${surface.name} no longer reserves titlebar-safe viewport space`).toContain(
        'calc(100dvh - 88px)'
      );
      expect(surfaceBlock, `${surface.name} no longer scrolls vertically`).toMatch(
        /overflow-y:\s*auto(?:\s*!important)?/
      );
      expect(surfaceBlock, `${surface.name} lost neutral Firefox scrollbar colors`).toContain(
        'scrollbar-color: var(--eve-scrollbar-thumb) var(--eve-scrollbar-track)'
      );
      expect(surfaceBlock, `${surface.name} lost its thin scrollbar contract`).toMatch(/scrollbar-width:\s*thin/);
      expect(surfaceBlock, `${surface.name} must not recolor scrollbars with action or brand tokens`).not.toMatch(
        /scrollbar[^;{}]*(?:--eve-(?:accent|action|brand)|--primary)/
      );
    }
  });

  it('prevents appearance presets from recoloring scrollbar thumbs', () => {
    for (const preset of themePresetCss) {
      const scrollbarRules = [...preset.source.matchAll(/[^{}]*scrollbar[^{}]*\{([^{}]*)\}/gi)];
      expect(scrollbarRules.length, `${preset.file} no longer exposes a scrollbar contract`).toBeGreaterThan(0);

      for (const [, declarations] of scrollbarRules) {
        for (const [, value] of declarations.matchAll(/background(?:-color)?\s*:\s*([^;]+);/gi)) {
          expect(value, `${preset.file} uses a non-neutral scrollbar background`).not.toMatch(
            /--eve-(?:accent|action|brand)|--primary|#[0-9a-f]{3,8}\b|rgba?\(/i
          );
          expect(value, `${preset.file} scrollbar backgrounds must consume the neutral lane`).toMatch(
            /transparent|var\(--eve-scrollbar-(?:thumb|thumb-hover|thumb-active|track)\)/
          );
        }
      }
    }
  });
});

describe('premium entry surfaces', () => {
  it('keeps login theme-aware through semantic shell, control and status roles', () => {
    for (const token of [
      '--eve-shell-canvas',
      '--eve-shell-surface',
      '--eve-shell-text',
      '--eve-shell-text-secondary',
      '--eve-control-surface',
      '--eve-control-surface-hover',
      '--eve-control-border',
      '--eve-control-border-hover',
      '--eve-overlay-shadow',
      '--eve-status-error',
      '--eve-status-completed',
    ]) {
      expect(loginCss, `login no longer consumes ${token}`).toContain(`var(${token}`);
    }
    expect(loginCss).toContain('var(--eve-motion-duration-feedback, 300ms)');
    expect(loginCss).toContain('var(--eve-motion-duration-state, 400ms)');
  });

  it('keeps registration theme-aware through semantic shell, control and focus roles', () => {
    for (const token of [
      '--eve-shell-canvas',
      '--eve-shell-surface',
      '--eve-shell-text',
      '--eve-shell-text-secondary',
      '--eve-control-surface',
      '--eve-control-surface-hover',
      '--eve-control-border',
      '--eve-control-border-hover',
      '--eve-focus-ring',
      '--eve-action-hover',
      '--eve-status-error',
    ]) {
      expect(registrationCss, `registration no longer consumes ${token}`).toContain(`var(${token}`);
    }
    expect(registrationCss).toContain('var(--eve-motion-duration-feedback, 300ms)');
    expect(registrationCss).toContain('var(--eve-motion-duration-state, 400ms)');
  });
});

describe('premium motion accessibility', () => {
  it('collapses shared motion tokens for OS and product-level reduced effects', () => {
    const systemReducedMotion = block(visualCss, '@media (prefers-reduced-motion: reduce)');
    const productReducedMotion = block(visualCss, ":root[data-eve-reduced-effects='true'] {");

    for (const token of [
      '--eve-motion-duration-feedback',
      '--eve-motion-duration-state',
      '--eve-motion-duration-overlay-enter',
      '--eve-motion-duration-overlay-exit',
    ]) {
      expect(systemReducedMotion).toContain(`${token}: 0ms`);
      expect(productReducedMotion).toContain(`${token}: 0ms`);
    }
  });

  it('stops base animation and Arco transition motion without hiding state', () => {
    expect(block(baseCss, '@media (prefers-reduced-motion: reduce)')).toMatch(/\.loading,[\s\S]*animation:\s*none/);
    expect(block(arcoCss, '@media (prefers-reduced-motion: reduce)')).toContain('transition: none !important');
    expect(arcoCss).toMatch(/prefers-reduced-motion:[\s\S]*transition-duration:\s*0ms !important/);
  });
});
