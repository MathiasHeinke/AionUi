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
import fs from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  setMaxEngaged: vi.fn(),
  authority: { maxActive: false },
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
// THE AUTHORITY IS AN EXTERNAL BOUNDARY, so it is supplied explicitly rather than
// derived here. Deriving it would rebuild the parallel model this whole change
// deleted; the decision logic itself is covered in eveMaxAuthority.test.ts.
vi.mock('@renderer/hooks/agent/useEveMaxAuthority', () => ({
  useEveMaxAuthority: () => ({ maxActive: mocks.authority.maxActive, state: { status: 'ready' }, refresh: vi.fn() }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

import EveMaxToggle from '@/renderer/components/agent/EveMaxToggle';
import { EVE_MAX_COMPOSER_ATTRIBUTE } from '@/renderer/components/agent/EveMaxToggle';
import {
  buildEvePickerGroups,
  EVE_INFERENCE_MAX_TIER_ID,
  EVE_INFERENCE_STANDARD_TIER_ID,
  EVE_INFERENCE_TIERS,
  eveTierValue,
  resolveEveWireLaneDecision,
} from '@/common/config/eveInferenceCore';

/** CSS comments legitimately mention selector names; only real rules count. */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every selector of every rule in `css` that targets the MAX toggle. */
function maxToggleSelectors(css: string): string[] {
  return (stripCssComments(css).match(/^[^{}@]*eve-max-toggle[^{}]*\{/gm) ?? [])
    .map((head) => head.replace(/\{$/, '').trim())
    .flatMap((head) => head.split(',').map((s) => s.trim()))
    .filter((s) => s.length > 0 && s.includes('eve-max-toggle'));
}

const UNIFIED_SEND_BAR_CSS = fs.readFileSync(
  path.resolve(__dirname, '../../../packages/desktop/src/renderer/components/chat/UnifiedSendBar.css'),
  'utf-8'
);

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

/**
 * Apply a state patch, then derive `maxActive` FROM THE REAL PRODUCT SOURCE.
 *
 * This used to compute `maxEngaged && maxAvailable` inline while IMPORTING
 * `resolveEveWireLaneDecision` and never calling it — a PARALLEL model
 * of the product's rule wearing the real function's name in a comment. That is
 * the failure this ticket keeps hitting: the mock and the component computed the
 * SAME expression from the SAME two inputs, so a component that ignored the
 * main-process authority entirely and derived `maxEngaged && maxAvailable`
 * itself would have passed every test in this file. The authority was asserted,
 * never exercised.
 *
 * So the default authority answer now goes through the REAL resolver — the same
 * core the main-side decision uses — over a REAL selection value built by
 * `eveTierValue`. And because agreeing-by-default still cannot prove the
 * component READS the authority, the DIVERGENCE block at the bottom of this file
 * makes the two inputs disagree on purpose. Deleting the `useEveMaxAuthority`
 * wiring from the component turns that block red (mutation-proved).
 */
function authorityAnswerFor(hookState: typeof mocks.hookState): boolean {
  // What MAIN is asked: "would the wire serve `max` for this seat right now?"
  // Intent becomes a selection value; entitlement becomes the seat's wire
  // entitlement. No second implementation of the rule lives in this file.
  const selection = eveTierValue(hookState.maxEngaged ? EVE_INFERENCE_MAX_TIER_ID : EVE_INFERENCE_STANDARD_TIER_ID);
  const decision = resolveEveWireLaneDecision(selection, { maxEntitled: hookState.maxAvailable });
  return decision.status === 'send' && decision.tier === 'max';
}

function setState(next: Partial<typeof mocks.hookState> & { authorityMaxActive?: boolean }): void {
  const { authorityMaxActive, ...hookPatch } = next;
  Object.assign(mocks.hookState, hookPatch);
  // The MAIN process decides this. When a test does not say otherwise, the
  // authority answers with the real resolver — but it is an INPUT here, never
  // something this file recomputes, and a test may override it to disagree.
  mocks.authority.maxActive = authorityMaxActive ?? authorityAnswerFor(mocks.hookState);
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

  it('ENGAGED: reads pressed, and a click disengages back to the routine lane', () => {
    setState({ maxEngaged: true, maxState: 'engaged' });
    renderInComposer();
    const button = screen.getByTestId('eve-max-toggle');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('data-active')).toBe('true');
    fireEvent.click(button);
    expect(mocks.setMaxEngaged).toHaveBeenCalledWith(false);
  });

  it('LOCKED + ENGAGED (the fifth state): announces NOT pressed, because the wire clamps', () => {
    // A lapsed seat keeps its persisted MAX intent, but MAX is not running — the
    // wire clamps to the routine lane. Announcing aria-pressed=true would tell a
    // screen-reader user the strong lane is active when it is not.
    //
    // WHICH ATTRIBUTE MEANS WHAT — the distinction this whole surface-honesty fix
    // exists for, so no one blurs it back:
    //   data-engaged = INTENT ONLY. What the user last chose. It survives a lapse
    //                  and it is NOT a statement about what is running.
    //   data-active  = STATE. Derived from production `maxActive`, i.e. the
    //                  EFFECTIVE WIRE TIER === 'max'. This is what is actually
    //                  being served this turn.
    //
    // The COMPOSER SURFACE must follow data-active / maxActive and must NEVER
    // follow data-engaged. Painting from intent is precisely the defect that
    // shipped: a lapsed seat wore the full MAX glow while the wire was clamping
    // that same turn to the routine lane — the surface asserting a state the
    // system was not in. data-engaged is for the PILL (so a remembered choice
    // stays visible on the control the user pressed), never for the surface.
    setState({ maxEngaged: true, maxAvailable: false, maxLocked: true, maxState: 'locked' });
    renderInComposer();
    const button = screen.getByTestId('eve-max-toggle');

    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('data-engaged')).toBe('true');
    expect(button.getAttribute('data-active')).toBe('false');
    // ...and the label says the honest thing: intent kept, needs a plan.
    expect(button.getAttribute('aria-label')).toContain('gemerkt');
  });

  it('ARIA is never self-contradictory: pressed implies operable in EVERY state', () => {
    for (const state of [
      { maxEngaged: false, maxAvailable: true, maxLocked: false, maxState: 'available' as const },
      { maxEngaged: true, maxAvailable: true, maxLocked: false, maxState: 'engaged' as const },
      { maxEngaged: false, maxAvailable: false, maxLocked: true, maxState: 'locked' as const },
      { maxEngaged: true, maxAvailable: false, maxLocked: true, maxState: 'locked' as const },
    ]) {
      setState(state);
      const { unmount } = renderInComposer();
      const button = screen.getByTestId('eve-max-toggle');
      const pressed = button.getAttribute('aria-pressed') === 'true';
      const ariaDisabled = button.getAttribute('aria-disabled') === 'true';
      expect(pressed && ariaDisabled, `contradictory ARIA for ${state.maxState}`).toBe(false);
      unmount();
    }
  });

  it('LOCKED: still RENDERED with an upsell hint, and the click REACHES the hook to be refused', () => {
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
    // THIS ASSERTION FLIPPED, AND THE OLD ONE WAS PART OF THE DEFECT.
    //
    // It used to require `setMaxEngaged` NOT to be called — i.e. it PINNED the
    // component swallowing the click. That is precisely what made the hook's
    // `intentRefused` unreachable and left an impermissible intent resolving into
    // nothing a user could see. The money gate has ONE owner (the hook), which
    // RAISES the refusal instead of writing; this surface's job is to deliver the
    // click and render the answer. The rendered half is proved end-to-end in
    // tests/unit/command-eve/eveMaxIntentVisibleResolution.dom.test.tsx.
    fireEvent.click(button);
    expect(mocks.setMaxEngaged).toHaveBeenCalledWith(true);
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

describe('EveMaxToggle — the surface follows the MAIN-PROCESS AUTHORITY, not the local state', () => {
  /**
   * THE MUTATION THESE EXIST FOR, stated so nobody deletes them as redundant.
   *
   * Replace the component's `const { maxActive } = useEveMaxAuthority()` with a
   * renderer-local `maxEngaged && maxAvailable` and EVERY other test in this file
   * stays green — because everywhere else the two agree by construction. Only a
   * DISAGREEMENT can tell an authority-driven surface from one that recomputes
   * the answer, so these make the two inputs disagree, once in each direction.
   * That is the whole content of the claim "independent main-process authority".
   */
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

  it('AUTHORITY SAYS NO while intent AND entitlement both say yes: nothing paints', () => {
    setState({
      maxEngaged: true,
      maxAvailable: true,
      maxLocked: false,
      maxState: 'engaged',
      authorityMaxActive: false,
    });
    const { composer } = renderInComposer();
    const button = screen.getByTestId('eve-max-toggle');
    expect(composer().hasAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe(false);
    expect(button.getAttribute('data-active')).toBe('false');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    // Intent is still the user's, and still visible on the pill.
    expect(button.getAttribute('data-engaged')).toBe('true');
  });

  it('AUTHORITY SAYS YES while the local intent says no: the surface still follows MAIN', () => {
    setState({
      maxEngaged: false,
      maxAvailable: true,
      maxLocked: false,
      maxState: 'available',
      authorityMaxActive: true,
    });
    const { composer } = renderInComposer();
    const button = screen.getByTestId('eve-max-toggle');
    expect(composer().getAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe('true');
    expect(button.getAttribute('data-active')).toBe('true');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.getAttribute('data-engaged')).toBe('false');
  });

  it('the DEFAULT answer is produced by the REAL resolver, not by a boolean written here', () => {
    // Drives `eveTierValue` + `resolveEveWireLaneDecision` — the same
    // core the main-side decision uses. If the product's clamp rule changed, this
    // file's default answer changes with it, instead of a hand-written
    // `maxEngaged && maxAvailable` quietly keeping the old one.
    expect(authorityAnswerFor({ ...mocks.hookState, maxEngaged: true, maxAvailable: true })).toBe(true);
    expect(authorityAnswerFor({ ...mocks.hookState, maxEngaged: true, maxAvailable: false })).toBe(false);
    expect(authorityAnswerFor({ ...mocks.hookState, maxEngaged: false, maxAvailable: true })).toBe(false);
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

  it('does NOT borrow the 32x32 compact-pill class that clamped its label (R2 hit-target)', () => {
    // `.agent-mode-compact-pill` inside .unified-send-bar forces a 32x32 icon
    // footprint AND hides the label. MAX is the only pill with a word in it, so
    // borrowing that class gave it a 32px box around ~52px of content, and the
    // overflow overlapped the NEIGHBOURING control's hit target.
    setState({ maxEngaged: false, maxState: 'available' });
    renderInComposer();
    const button = screen.getByTestId('eve-max-toggle');
    expect(button.className).toContain('eve-max-toggle');
    expect(button.className).not.toContain('agent-mode-compact-pill');
    expect(button.className).not.toContain('sendbox-model-btn');
  });

  it('does NOT use Arco type=primary, whose disabled styling made the wordmark invisible (R1)', () => {
    // In LIGHT theme, primary + Arco's two-class disabled rule beat the send
    // bar's `:where()`-written colour rule (which contributes zero specificity),
    // rendering white text on a near-white composer. Engagement is expressed by
    // data-active in CSS this repo owns instead.
    for (const state of [
      { maxEngaged: true, maxAvailable: true, maxLocked: false, maxState: 'engaged' as const },
      { maxEngaged: false, maxAvailable: true, maxLocked: false, maxState: 'available' as const },
    ]) {
      setState(state);
      const { unmount } = renderInComposer({ disabled: true });
      const button = screen.getByTestId('eve-max-toggle');
      expect(button.className).not.toContain('arco-btn-primary');
      unmount();
    }
  });

  it('gives real feedback on engage: data-active flips on the pill itself (R3)', () => {
    setState({ maxEngaged: false, maxAvailable: true, maxLocked: false, maxState: 'available' });
    const off = renderInComposer();
    expect(screen.getByTestId('eve-max-toggle').getAttribute('data-active')).toBe('false');
    off.unmount();

    setState({ maxEngaged: true, maxAvailable: true, maxLocked: false, maxState: 'engaged' });
    renderInComposer();
    expect(screen.getByTestId('eve-max-toggle').getAttribute('data-active')).toBe('true');
  });

  it('R4: EVERY MAX styling rule still matches the button when it is DISABLED/busy', () => {
    // THE DEFECT THIS EXISTS FOR: Arco's Tooltip, wrapping a DISABLED button,
    // relocates the button's `className` onto a wrapper span. Reproduced here in
    // jsdom — the button ends up with only Arco's own classes, so every
    // `.eve-max-toggle`-keyed rule stops matching in exactly the busy state R1
    // was filed about (measured in the real app: 67.7->75.7px wide, 32->28px
    // tall, radius 999->14px, weight 600->400, label contrast 1.50:1).
    //
    // So this does NOT assert on the class. It reads the REAL selectors out of
    // the stylesheet and requires each one to match a real rendered DOM in some
    // state — including the disabled states. Reverting the CSS to class-keyed
    // selectors makes the extracted selectors stop matching and turns this red.
    const maxSelectors = maxToggleSelectors(UNIFIED_SEND_BAR_CSS)
      // Pseudo-classes cannot be matched by querySelector against a static DOM.
      .filter((s) => !/:hover|:focus-visible/.test(s));

    expect(maxSelectors.length).toBeGreaterThan(4);

    // Render every state the rules target, all in the DISABLED/busy variant.
    const rendered: Document[] = [];
    for (const state of [
      { maxEngaged: true, maxAvailable: true, maxLocked: false, maxState: 'engaged' as const },
      { maxEngaged: false, maxAvailable: false, maxLocked: true, maxState: 'locked' as const },
      { maxEngaged: false, maxAvailable: true, maxLocked: false, maxState: 'available' as const },
    ]) {
      setState(state);
      const view = renderInComposer({ disabled: true });
      const button = screen.getByTestId('eve-max-toggle');
      // The precondition, asserted so the test cannot quietly stop exercising
      // the relocation: this IS the disabled path.
      expect(button.hasAttribute('disabled')).toBe(true);
      rendered.push(document.cloneNode(true) as Document);
      view.unmount();
    }

    for (const selector of maxSelectors) {
      const matchedSomewhere = rendered.some((doc) => doc.querySelector(selector) !== null);
      expect(matchedSomewhere, `MAX rule never matches a disabled button: ${selector}`).toBe(true);
    }
  });

  it('R4: the sizing + colour hooks are attribute/anchor based, not class based', () => {
    // Cheap structural guard next to the behavioural one above: the two hooks
    // that survive Arco's relocation must actually be what the rules use.
    for (const selector of maxToggleSelectors(UNIFIED_SEND_BAR_CSS)) {
      {
        // Either it scopes through our own anchor span, or it targets our own
        // inner label/content class — both survive the wrapper. What must NOT
        // appear is a bare `.eve-max-toggle` on the button itself.
        const usesSurvivingHook =
          selector.includes('.eve-max-toggle-anchor') ||
          selector.includes('.eve-max-toggle__label') ||
          selector.includes('.eve-max-toggle__content');
        expect(usesSurvivingHook, `class-keyed MAX selector will die on disabled: ${selector}`).toBe(true);
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
