/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EveMaxToggle — the MAX lane control and the composer state it drives.
 *
 * NAMING: this file MUST end in `.dom.test.tsx`. vitest.config.ts's `node`
 * project includes `tests/unit/**\/*.test.ts` (not `.tsx`) and the `dom` project
 * includes ONLY `*.dom.test.ts` / `*.dom.test.tsx`, so a file called
 * `EveMaxToggle.test.tsx` would match NEITHER project and "pass" by never
 * running at all.
 *
 * What is pinned here:
 *   - `data-eve-max` toggles on the CONTAINING composer surface (and only that one);
 *   - every MAX control state is reachable and accessible;
 *   - reduced motion keeps the STATE (the attribute) while the stylesheet drops
 *     the motion;
 *   - no raw model id / provider slug ever reaches the composer or picker DOM.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setMaxEngaged: vi.fn(),
  hookState: {
    maxEngaged: false,
    maxAvailable: true,
    maxLocked: false,
    maxState: 'available' as 'available' | 'locked' | 'engaged',
    setMaxEngaged: vi.fn(),
  },
}));

vi.mock('@/renderer/hooks/agent/useEveInferenceSelection', () => ({
  useEveInferenceSelection: () => mocks.hookState,
}));
vi.mock('@renderer/hooks/agent/useEveInferenceSelection', () => ({
  useEveInferenceSelection: () => mocks.hookState,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

import EveMaxToggle from '@/renderer/components/agent/EveMaxToggle';
import { EVE_MAX_COMPOSER_ATTRIBUTE } from '@/renderer/components/agent/EveMaxToggle';
import { buildEvePickerGroups, EVE_INFERENCE_TIERS } from '@/common/config/eveInferenceCore';

/** Render the toggle inside a real composer surface, exactly as the send bars do. */
function renderInComposer(props: { disabled?: boolean } = {}) {
  const utils = render(
    <div className='sendbox-panel eve-panel eve-composer-surface' data-testid='composer'>
      <div className='unified-send-bar'>
        <EveMaxToggle {...props} />
      </div>
    </div>
  );
  return { ...utils, composer: () => utils.getByTestId('composer') };
}

function setState(next: Partial<typeof mocks.hookState>): void {
  Object.assign(mocks.hookState, next);
}

describe('EveMaxToggle — composer MAX state', () => {
  beforeEach(() => {
    mocks.setMaxEngaged.mockReset();
    setState({
      maxEngaged: false,
      maxAvailable: true,
      maxLocked: false,
      maxState: 'available',
      setMaxEngaged: mocks.setMaxEngaged,
    });
    document.documentElement.removeAttribute('data-eve-reduced-effects');
  });

  it('stamps data-eve-max="true" on the composer when MAX is engaged', () => {
    setState({ maxEngaged: true, maxState: 'engaged' });
    const { composer } = renderInComposer();
    expect(composer().getAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe('true');
  });

  it('leaves the composer unmarked when MAX is not engaged', () => {
    const { composer } = renderInComposer();
    expect(composer().hasAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe(false);
  });

  it('toggles the attribute off again when MAX is disengaged', () => {
    setState({ maxEngaged: true, maxState: 'engaged' });
    const { composer, rerender } = renderInComposer();
    expect(composer().getAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe('true');

    setState({ maxEngaged: false, maxState: 'available' });
    rerender(
      <div className='sendbox-panel eve-panel eve-composer-surface' data-testid='composer'>
        <div className='unified-send-bar'>
          <EveMaxToggle />
        </div>
      </div>
    );
    expect(composer().hasAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe(false);
  });

  it('clears the attribute on unmount — a composer must never stay painted for a lane it left', () => {
    setState({ maxEngaged: true, maxState: 'engaged' });
    const { composer, unmount } = renderInComposer();
    const node = composer();
    expect(node.getAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe('true');
    unmount();
    expect(node.hasAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe(false);
  });

  it('marks ONLY the composer that contains the control, never every composer on screen', () => {
    setState({ maxEngaged: true, maxState: 'engaged' });
    render(
      <div>
        <div className='eve-composer-surface' data-testid='other-composer' />
        <div className='eve-composer-surface' data-testid='eve-composer'>
          <EveMaxToggle />
        </div>
      </div>
    );
    expect(screen.getByTestId('eve-composer').getAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe('true');
    expect(screen.getByTestId('other-composer').hasAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe(false);
  });

  it('REDUCED MOTION: the MAX state survives — only the stylesheet drops the motion', () => {
    // Both established reduced-motion signals are set. The control must NOT
    // remove the state: under reduced motion MAX still has to be visible, it
    // simply stops animating (proved against the stylesheet in
    // eveMaxComposerCss.test.ts).
    document.documentElement.setAttribute('data-eve-reduced-effects', 'true');
    const matchMediaMock = vi.fn().mockReturnValue({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn(),
    });
    vi.stubGlobal('matchMedia', matchMediaMock);

    setState({ maxEngaged: true, maxState: 'engaged' });
    const { composer } = renderInComposer();

    expect(composer().getAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe('true');
    expect(screen.getByTestId('eve-max-toggle').getAttribute('data-engaged')).toBe('true');
    vi.unstubAllGlobals();
  });
});

describe('EveMaxToggle — control states (spec 2.6)', () => {
  beforeEach(() => {
    mocks.setMaxEngaged.mockReset();
    setState({
      maxEngaged: false,
      maxAvailable: true,
      maxLocked: false,
      maxState: 'available',
      setMaxEngaged: mocks.setMaxEngaged,
    });
  });

  it('AVAILABLE: operable, not pressed, and a click engages MAX', () => {
    renderInComposer();
    const button = screen.getByTestId('eve-max-toggle');
    expect(button).not.toBeDisabled();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('data-locked')).toBe('false');
    fireEvent.click(button);
    expect(mocks.setMaxEngaged).toHaveBeenCalledWith(true);
  });

  it('ENGAGED: reads pressed, and a click disengages back to Standard', () => {
    setState({ maxEngaged: true, maxState: 'engaged' });
    renderInComposer();
    const button = screen.getByTestId('eve-max-toggle');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(mocks.setMaxEngaged).toHaveBeenCalledWith(false);
  });

  it('LOCKED: still RENDERED with an upsell hint, announced disabled, and click is a no-op', () => {
    setState({ maxAvailable: false, maxLocked: true, maxState: 'locked' });
    renderInComposer();
    const button = screen.getByTestId('eve-max-toggle');
    // Rendered, never hidden — the upsell has to be visible to work.
    expect(button).toBeInTheDocument();
    expect(button.getAttribute('data-locked')).toBe('true');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // The label carries the UPSELL sentence (the i18n mock returns the DE
    // fallback), not a bare "unavailable".
    expect(button.getAttribute('aria-label')).toContain('bezahlten Tarif');
    expect(button.getAttribute('aria-label')).toContain('Credits');
    fireEvent.click(button);
    expect(mocks.setMaxEngaged).not.toHaveBeenCalled();
  });

  it('DISABLED (busy/loading): greyed and inert without changing which lane is engaged', () => {
    setState({ maxEngaged: true, maxState: 'engaged' });
    const { composer } = renderInComposer({ disabled: true });
    const button = screen.getByTestId('eve-max-toggle');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(mocks.setMaxEngaged).not.toHaveBeenCalled();
    // Busy must not silently re-lane the user.
    expect(composer().getAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe('true');
  });

  it('is a real button element: focusable, keyboard-operable, and labelled', () => {
    renderInComposer();
    const button = screen.getByTestId('eve-max-toggle');
    expect(button.tagName).toBe('BUTTON');
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute('aria-label')).toContain('MAX');
    // Space/Enter reach a native button through the browser's own click
    // synthesis; asserting the element type is what proves that path exists.
    expect(button.getAttribute('type')).not.toBe('submit');
  });

  it('every control state is reachable and each renders a distinct data-eve-max-state', () => {
    const seen = new Set<string>();
    for (const state of [
      { maxEngaged: false, maxAvailable: true, maxLocked: false, maxState: 'available' as const },
      { maxEngaged: true, maxAvailable: true, maxLocked: false, maxState: 'engaged' as const },
      { maxEngaged: false, maxAvailable: false, maxLocked: true, maxState: 'locked' as const },
    ]) {
      setState(state);
      const { unmount } = renderInComposer();
      const anchor = document.querySelector('.eve-max-toggle-anchor') as HTMLElement;
      seen.add(anchor.getAttribute('data-eve-max-state') ?? '');
      unmount();
    }
    expect([...seen].sort()).toEqual(['available', 'engaged', 'locked']);
  });
});

describe('EveMaxToggle — no raw model id in the composer DOM (spec 2.7 #9)', () => {
  beforeEach(() => {
    setState({
      maxEngaged: true,
      maxAvailable: true,
      maxLocked: false,
      maxState: 'engaged',
      setMaxEngaged: mocks.setMaxEngaged,
    });
  });

  it('renders MAX and nothing that could be a provider slug', () => {
    const { container } = renderInComposer();
    const text = container.textContent ?? '';
    expect(text).toContain('MAX');
    // Every upstream model id in this system is a `vendor/model` slug, so a '/'
    // in composer text is the tell. Checking the shape rather than a blacklist
    // means a model added tomorrow is caught too.
    expect(text).not.toContain('/');
  });

  it('no ARIA/title/data attribute leaks a slug either', () => {
    const { container } = renderInComposer();
    for (const node of Array.from(container.querySelectorAll('*'))) {
      for (const attr of Array.from(node.attributes)) {
        if (attr.name === 'class' || attr.name.startsWith('data-testid')) continue;
        expect(attr.value).not.toMatch(/[a-z0-9-]+\/[a-z0-9.-]+/i);
      }
    }
  });

  it('the REAL registry never leaks a slug into a user-facing field', () => {
    // Uses the real core rather than fabricated rows, so this fails if the
    // registry ever starts leaking an id into a user-facing field.
    const groups = buildEvePickerGroups({ trial_ends_at: null, has_paid_seat: true });
    const eve = groups.find((g) => g.kind === 'eve')!;
    for (const item of eve.items) {
      for (const text of [item.label, item.sublabel ?? '', item.costBadge ?? '']) {
        expect(text).not.toContain('/');
      }
    }
    // The registry's own wire tiers are levels, never slugs.
    for (const tier of EVE_INFERENCE_TIERS) {
      expect(tier.tier).not.toContain('/');
      expect(tier.label).not.toContain('/');
    }
  });
});

describe('EveMaxToggle — NO cloud tier nomenclature in the composer (Founder contract)', () => {
  /**
   * The routine EVE composer is UNNAMED. It communicates ONLY the additive MAX
   * state: off = EVE's normal behaviour, on = MAX. Every cloud-ladder word —
   * including the old default label "Standard" — must be absent from the
   * composer DOM, and no renamed equivalent may take its place.
   */
  const CLOUD_TIER_WORDS = ['Standard', 'Hoch', 'Sehr hoch', 'Maximum', 'Ultra', 'Stufe', 'Tier', 'Level'];

  beforeEach(() => {
    setState({ maxAvailable: true, maxLocked: false, setMaxEngaged: mocks.setMaxEngaged });
  });

  it.each([
    ['MAX off', { maxEngaged: false, maxState: 'available' as const }],
    ['MAX on', { maxEngaged: true, maxState: 'engaged' as const }],
    ['MAX locked', { maxEngaged: false, maxAvailable: false, maxLocked: true, maxState: 'locked' as const }],
  ])('%s: the composer renders no cloud tier word at all', (_name, state) => {
    setState(state);
    const { container } = renderInComposer();
    const text = container.textContent ?? '';
    for (const word of CLOUD_TIER_WORDS) {
      expect(text, `composer must not render "${word}"`).not.toContain(word);
    }
    // The one word it DOES say is MAX.
    expect(text).toContain('MAX');
  });

  it('no cloud tier word hides in an aria-label, title or data attribute either', () => {
    setState({ maxEngaged: true, maxState: 'engaged' });
    const { container } = renderInComposer();
    for (const node of Array.from(container.querySelectorAll('*'))) {
      for (const attr of Array.from(node.attributes)) {
        if (attr.name === 'class') continue;
        for (const word of CLOUD_TIER_WORDS) {
          expect(attr.value, `${attr.name} must not carry "${word}"`).not.toContain(word);
        }
      }
    }
  });

  it('the composer exposes EXACTLY ONE cloud-intelligence affordance', () => {
    setState({ maxEngaged: false, maxState: 'available' });
    const { container } = renderInComposer();
    // One control, and it is the MAX toggle. A second chooser here would be the
    // ladder coming back through the side door.
    expect(container.querySelectorAll('button')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="eve-max-toggle"]')).toHaveLength(1);
  });
});
