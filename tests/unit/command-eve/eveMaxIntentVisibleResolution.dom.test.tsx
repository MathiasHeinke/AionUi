/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE PENDING-INTENT FEATURE, END TO END, THROUGH THE REAL TOGGLE.
 *
 * WHY THIS FILE EXISTS. The feature was dead at BOTH ends and every existing test
 * missed it, because every existing test replaced one of the two ends with a mock:
 *
 *   INGRESS — `EveMaxToggle`'s `onToggle` returned early on `!maxAvailable`, and
 *             `maxAvailable` is false during the UNKNOWN window too. So a click
 *             made while entitlement was unverified never reached `setMaxEngaged`
 *             and never became a pending intent at all. The hook tests proved the
 *             hook holds a click — by calling `setMaxEngaged` themselves, which is
 *             exactly the call the surface was not making.
 *   EGRESS  — `intentRefused` / `intentPending` had NO rendered consumer;
 *             EveMaxToggle destructured neither. A hook test titled "resolves to a
 *             VISIBLE refusal" asserted a BOOLEAN, which is how a feature nobody
 *             can see shipped as closed.
 *
 * SO NOTHING HERE IS MOCKED THAT COULD HIDE EITHER END. The REAL component, the
 * REAL `useEveInferenceSelection`, the REAL `eveInferenceCore` gates and the REAL
 * shipped de-DE strings all run. Only genuine boundaries are stubbed: the two
 * entitlement transports (which are what "UNKNOWN" is a statement about), the
 * config store, the MAIN-process authority receipt, and the platform shell.
 *
 * AND EVERY ASSERTION IS ON WHAT A USER CAN SEE — rendered text and rendered DOM,
 * never a hook return value. Both halves are mutation-proved; see the SABOTAGE
 * notes on the two describe blocks.
 *
 * NAMING: `.dom.test.tsx` is mandatory. The vitest `node` project takes
 * `tests/unit/**\/*.test.ts` (never `.tsx`) and excludes `*.dom.test.*`; the `dom`
 * project takes ONLY `*.dom.test.ts(x)`. A plain `.test.tsx` matches NEITHER
 * project and "passes" by never running.
 */

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The SHIPPED German copy. A key that exists only in the component is red here. */
const CONVERSATION_DE = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../packages/desktop/src/renderer/services/i18n/locales/de-DE/conversation.json'),
    'utf-8'
  )
) as Record<string, unknown>;

/** Resolve a `conversation.x.y` key against the real locale file. */
function localized(key: string): string {
  const parts = key.replace(/^conversation\./, '').split('.');
  let cursor: unknown = CONVERSATION_DE;
  for (const part of parts) {
    cursor = (cursor as Record<string, unknown>)?.[part];
  }
  if (typeof cursor !== 'string') throw new Error(`missing de-DE copy for ${key}`);
  return cursor;
}

// ── BOUNDARIES ─────────────────────────────────────────────────────────────
// Everything below is a transport or a shell, i.e. a thing this process does not
// own. The DECISION logic — hook, gates, component — is the real thing.

const store: Map<string, unknown> = new Map();
const configSet = vi.fn((k: string, v: unknown) => {
  store.set(k, v);
});
vi.mock('@/common/config/configService', () => ({
  configService: {
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => configSet(k, v),
    subscribe: () => () => undefined,
  },
}));

/** The two funding authorities. `creditsOk=false` while entitled IS the UNKNOWN window. */
const authority = vi.hoisted(() => ({
  entitlement: {
    loading: false,
    status: { ok: true, state: 'entitled', has_paid_seat: false, edition: undefined as string | undefined },
  },
  credits: {
    loading: false,
    status: {
      ok: false,
      tier: 'free',
      purchased_credits_remaining: 0,
      included_allowance_credits_remaining: 0,
      has_active_topup: false,
    },
  },
}));
vi.mock('@renderer/hooks/useEntitlementGate', () => ({
  useEntitlementGate: () => ({ ...authority.entitlement, blocked: false, refresh: vi.fn() }),
}));
vi.mock('@renderer/hooks/useCreditsStatus', () => ({
  useCreditsStatus: () => ({ ...authority.credits, meter: null, refresh: vi.fn() }),
}));

/** MAIN's receipt about what the wire will serve. Never derived here. */
const mainAuthority = vi.hoisted(() => ({ maxActive: false, entitlementPending: true }));
vi.mock('@renderer/hooks/agent/useEveMaxAuthority', () => ({
  useEveMaxAuthority: () => ({ ...mainAuthority, state: { status: 'ready' }, refresh: vi.fn() }),
}));

/** The shell. `isElectronDesktop() === false` keeps the bearer probe inert. */
const openAccountWeb = vi.hoisted(() => vi.fn());
vi.mock('@renderer/utils/platform', () => ({
  isElectronDesktop: () => false,
  openAccountWeb,
  openExternalUrl: vi.fn(),
}));

/** i18n resolves against the REAL de-DE file, so the rendered text is shipped copy. */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => localized(key) }),
}));

import EveMaxToggle, { EVE_MAX_COMPOSER_ATTRIBUTE } from '@/renderer/components/agent/EveMaxToggle';
import { EVE_DEFAULT_INFERENCE_SELECTION, eveTierValue } from '@/common/config/eveInferenceCore';

const MAX_SELECTION = eveTierValue('eve-max');
const SELECTION_KEY = 'commandEve.inferenceSelection';

function renderInComposer() {
  const utils = render(
    <div className='sendbox-panel eve-panel eve-composer-surface' data-testid='composer'>
      <div className='unified-send-bar'>
        <EveMaxToggle />
      </div>
    </div>
  );
  return { ...utils, composer: () => utils.getByTestId('composer') };
}

/** The visible answer, or null if the surface rendered none. */
const noticeNode = (): HTMLElement | null => screen.queryByTestId('eve-max-intent-notice');

beforeEach(() => {
  store.clear();
  store.set(SELECTION_KEY, EVE_DEFAULT_INFERENCE_SELECTION);
  configSet.mockClear();
  openAccountWeb.mockClear();
  authority.entitlement.loading = false;
  authority.entitlement.status = { ok: true, state: 'entitled', has_paid_seat: false, edition: undefined };
  authority.credits.loading = false;
  authority.credits.status = {
    ok: false,
    tier: 'free',
    purchased_credits_remaining: 0,
    included_allowance_credits_remaining: 0,
    has_active_topup: false,
  };
  mainAuthority.maxActive = false;
  mainAuthority.entitlementPending = true;
});

describe('INGRESS: a click during UNKNOWN becomes a held intent, and the user is told', () => {
  /**
   * SABOTAGE THAT MUST REDDEN THIS BLOCK: put `|| !maxAvailable` back into
   * EveMaxToggle's `onToggle` guard. `maxAvailable` is false during UNKNOWN, so the
   * click stops at the component, no intent is held, and no notice renders.
   */
  it('renders the held-intent sentence a user can read — not a boolean', () => {
    renderInComposer();
    expect(noticeNode()).toBeNull(); // nothing claimed before the click

    fireEvent.click(screen.getByTestId('eve-max-toggle'));

    const notice = noticeNode();
    expect(notice, 'the click during UNKNOWN produced no visible answer at all').not.toBeNull();
    expect(notice!.getAttribute('data-kind')).toBe('held');
    expect(notice!.textContent).toContain(localized('conversation.eveMax.intentHeldNotice'));
    // A live region, so a screen reader hears the answer without hunting for it.
    expect(notice!.getAttribute('role')).toBe('status');
    expect(notice!.getAttribute('aria-live')).toBe('polite');
  });

  it('holds it IN MEMORY: no MAX paint, no MAX on the pill, and NOTHING on disk', () => {
    renderInComposer();
    fireEvent.click(screen.getByTestId('eve-max-toggle'));

    const button = screen.getByTestId('eve-max-toggle');
    // No paint: the composer is not wearing MAX and the pill does not claim it.
    expect(screen.getByTestId('composer').hasAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe(false);
    expect(button.getAttribute('data-active')).toBe('false');
    expect(button.getAttribute('data-engaged')).toBe('false');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    // No wire: the send path re-reads the DISK key, and the disk is untouched.
    expect(configSet.mock.calls.filter(([key]) => key === SELECTION_KEY)).toHaveLength(0);
    expect(store.get(SELECTION_KEY)).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
  });

  it('the checking pill is operable, so the click it accepts is not announced as impossible', () => {
    renderInComposer();
    const anchor = document.querySelector('.eve-max-toggle-anchor') as HTMLElement;
    expect(anchor.getAttribute('data-eve-max-state')).toBe('checking');
    expect(screen.getByTestId('eve-max-toggle').getAttribute('aria-disabled')).toBe('false');
  });

  it('a held intent is OBEYED once the answer is YES — the click was never thrown away', async () => {
    const view = renderInComposer();
    fireEvent.click(screen.getByTestId('eve-max-toggle'));
    expect(noticeNode()!.getAttribute('data-kind')).toBe('held');

    // The answer lands, and it is yes: a real purchased-credit balance.
    act(() => {
      authority.credits.status = { ...authority.credits.status, ok: true, purchased_credits_remaining: 5000 };
      mainAuthority.entitlementPending = false;
      mainAuthority.maxActive = true;
    });
    view.rerender(
      <div className='sendbox-panel eve-panel eve-composer-surface' data-testid='composer'>
        <div className='unified-send-bar'>
          <EveMaxToggle />
        </div>
      </div>
    );

    await waitFor(() => {
      expect(configSet).toHaveBeenCalledWith(SELECTION_KEY, MAX_SELECTION);
    });
    // The held sentence retires once it has been acted on.
    expect(noticeNode()).toBeNull();
    expect(screen.getByTestId('eve-max-toggle').getAttribute('data-engaged')).toBe('true');
  });
});

describe('EGRESS: an authoritative NO renders a calm locked/upsell answer', () => {
  /**
   * SABOTAGE THAT MUST REDDEN THIS BLOCK: delete the `notice` JSX from
   * EveMaxToggle (or stop destructuring `intentRefused`). The hook still flips its
   * boolean — which is precisely what the previous test suite asserted — and the
   * user still sees nothing.
   */
  beforeEach(() => {
    // ANSWERED, and the answer is no: an authoritative credits read with a free
    // tier, no purchased balance, no paid seat.
    authority.credits.status = { ...authority.credits.status, ok: true };
    mainAuthority.entitlementPending = false;
  });

  it('a click on the locked pill renders the refusal sentence, non-modally', () => {
    renderInComposer();
    const button = screen.getByTestId('eve-max-toggle');
    expect(button.getAttribute('data-locked')).toBe('true');
    expect(noticeNode()).toBeNull();

    fireEvent.click(button);

    const notice = noticeNode();
    expect(notice, 'the refused click produced no visible answer at all').not.toBeNull();
    expect(notice!.getAttribute('data-kind')).toBe('refused');
    expect(notice!.textContent).toContain(localized('conversation.eveMax.intentRefusedNotice'));
    // NON-MODAL: nothing overlays the app and nothing steals focus.
    expect(document.querySelector('.arco-modal')).toBeNull();
    expect(document.activeElement).not.toBe(notice);
  });

  it('the refusal carries the upsell and a dismissal — and writes nothing either way', () => {
    renderInComposer();
    fireEvent.click(screen.getByTestId('eve-max-toggle'));

    const unlock = screen.getByText(localized('conversation.eveMax.upgrade'));
    fireEvent.click(unlock);
    expect(openAccountWeb).toHaveBeenCalledWith('/account?tab=credits');

    fireEvent.click(screen.getByText(localized('conversation.eveMax.noticeDismiss')));
    expect(noticeNode()).toBeNull();

    // A refused intent is a refusal, not a write: the shared key never moved.
    expect(configSet.mock.calls.filter(([key]) => key === SELECTION_KEY)).toHaveLength(0);
    expect(store.get(SELECTION_KEY)).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
  });

  it('the refusal never paints MAX — the pill and the composer both stay off', () => {
    renderInComposer();
    fireEvent.click(screen.getByTestId('eve-max-toggle'));
    const button = screen.getByTestId('eve-max-toggle');
    expect(screen.getByTestId('composer').hasAttribute(EVE_MAX_COMPOSER_ATTRIBUTE)).toBe(false);
    expect(button.getAttribute('data-active')).toBe('false');
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('a HELD intent that the answer then refuses also surfaces, not just a direct click', () => {
    // The other route into a refusal, and the one the hook's resolve effect owns:
    // click during UNKNOWN, then the answer lands and says no.
    authority.credits.status = { ...authority.credits.status, ok: false };
    mainAuthority.entitlementPending = true;
    const view = renderInComposer();
    fireEvent.click(screen.getByTestId('eve-max-toggle'));
    expect(noticeNode()!.getAttribute('data-kind')).toBe('held');

    act(() => {
      authority.credits.status = { ...authority.credits.status, ok: true };
      mainAuthority.entitlementPending = false;
    });
    view.rerender(
      <div className='sendbox-panel eve-panel eve-composer-surface' data-testid='composer'>
        <div className='unified-send-bar'>
          <EveMaxToggle />
        </div>
      </div>
    );

    expect(noticeNode()!.getAttribute('data-kind')).toBe('refused');
    expect(noticeNode()!.textContent).toContain(localized('conversation.eveMax.intentRefusedNotice'));
    expect(configSet.mock.calls.filter(([key]) => key === SELECTION_KEY)).toHaveLength(0);
  });
});
