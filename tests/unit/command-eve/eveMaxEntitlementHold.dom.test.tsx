/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE SURFACE HALF of the entitlement contract: what the user SEES and whether
 * they can SEND, for each of the three states of signed entitlement.
 *
 * The wire half lives in `eveMaxEntitlementHold.test.ts` (node), which asserts the
 * tier a request would actually carry. This file asserts the two things the user
 * experiences, driven from the SAME main-process receipt:
 *
 *   PAINT — UNKNOWN paints neither MAX nor a dressed-up Standard. It paints a
 *           fourth, NEUTRAL state carrying the real de-DE copy.
 *   HOLD  — UNKNOWN disables submission, and the hold LIFTS in both resolutions.
 *
 * WHAT IS REAL HERE. The `useEveMaxAuthority` hook, the `EveMaxToggle` component,
 * the `useGuidSend` send funnel, and the shipped locale JSON are all production
 * code. The only boundary mocked is the Electron IPC that carries the receipt —
 * i.e. the thing MAIN answers — plus the entitlement/selection surfaces that are
 * not the subject here. The copy assertions read the ACTUAL locale files, so a
 * key that exists only in the component is red, not green.
 *
 * NAMING: `.dom.test.tsx`. The `node` project includes `tests/unit/**\/*.test.ts`
 * (never `.tsx`) and excludes `*.dom.test.*`; the `dom` project includes ONLY
 * `*.dom.test.ts(x)`. A plain `.test.tsx` would match NEITHER and "pass" by never
 * running at all.
 */

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SEAT = 'seat-acme-gmbh';
const REVISION = 7;
const MAX_SELECTION = 'command-eve-inference:eve-max';

/** What MAIN would answer right now. Exactly the receipt shape the bridge returns. */
const main = vi.hoisted(() => ({
  receipt: { maxActive: false, wireTier: undefined as string | undefined, laneHold: undefined as string | undefined },
  calls: 0,
}));

/** The composer's own entitlement view — the picker's lock/upsell axis, not the wire. */
const selectionHook = vi.hoisted(() => ({
  state: {
    maxEngaged: true,
    maxAvailable: false,
    maxLocked: true,
    maxState: 'locked' as 'available' | 'locked' | 'engaged',
    setMaxEngaged: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// BOUNDARY — the Electron IPC to MAIN. This is the only thing under test that is
// simulated: everything above it (hook, component, send funnel) is production.
// ---------------------------------------------------------------------------
vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    inferenceLaneDecision: {
      invoke: vi.fn(async () => {
        main.calls += 1;
        return { success: true, data: { seatId: SEAT, seatContextRevision: REVISION, ...main.receipt } };
      }),
    },
    seatContext: {
      invoke: vi.fn(async () => ({ success: true, data: { seatId: SEAT, seatContextRevision: REVISION } })),
    },
  },
}));

const configGetMock = vi.hoisted(() => vi.fn());
vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    set: vi.fn(),
    whenReady: vi.fn().mockResolvedValue(undefined),
    getCurrentSeatId: () => SEAT,
    onSeatRebind: () => () => undefined,
    subscribePersisted: () => () => undefined,
  },
}));

// The picker/entitlement hook is a DIFFERENT question from the wire decision and
// is covered elsewhere; supplying it keeps this file about the authority.
vi.mock('@renderer/hooks/agent/useEveInferenceSelection', () => ({
  useEveInferenceSelection: () => selectionHook.state,
}));
vi.mock('@/renderer/hooks/agent/useEveInferenceSelection', () => ({
  useEveInferenceSelection: () => selectionHook.state,
}));

// The start-screen send funnel's own IPC surface. Held turns never reach it; the
// restored ones are only required to GET PAST the guard, not to succeed.
vi.mock('@/common', () => ({
  ipcBridge: {
    commandEve: {
      evaluateGateDecision: { invoke: vi.fn().mockResolvedValue({ success: true }) },
      ensureAssistant: { invoke: vi.fn().mockResolvedValue({ success: false }) },
      resolveInferenceProvider: { invoke: vi.fn().mockResolvedValue({ success: false }) },
      runtimeStatus: { invoke: vi.fn().mockResolvedValue({ success: false }) },
      warmLocalModel: { invoke: vi.fn().mockResolvedValue({ success: false }) },
    },
    conversation: { create: { invoke: vi.fn().mockResolvedValue({ success: false }) } },
  },
}));

// Arco stays REAL (the toggle renders a real Button + Tooltip). Only the global
// toast is stubbed: a RESTORED send is expected to get past the guard and then
// fail on the mocked bridge, and Arco's imperative Message renders through a
// legacy ReactDOM.render that jsdom + React 19 cannot serve.
vi.mock('@arco-design/web-react', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  Message: { error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));

// ---------------------------------------------------------------------------
// THE REAL SHIPPED COPY. `t` resolves against the actual locale JSON, so a key
// the component invents but no locale defines renders as the raw key and fails.
// ---------------------------------------------------------------------------
const LOCALES = path.resolve(__dirname, '../../../packages/desktop/src/renderer/services/i18n/locales');
const loadLocale = (locale: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(LOCALES, locale, 'conversation.json'), 'utf-8')) as Record<string, unknown>;
const DE = loadLocale('de-DE');
const EN = loadLocale('en-US');

function lookup(bundle: Record<string, unknown>, key: string): string | undefined {
  // Component keys are namespaced `conversation.*`; the bundle is that namespace.
  const parts = key.replace(/^conversation\./, '').split('.');
  let node: unknown = bundle;
  for (const part of parts) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

const activeLocale = { bundle: DE };
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // NOTE: the shipped string WINS over any inline defaultValue. A component that
    // silently fell back to a hardcoded twin would render the twin and be caught.
    t: (key: string, fallback?: string) => lookup(activeLocale.bundle, key) ?? fallback ?? key,
    i18n: { language: 'de-DE' },
  }),
}));

import EveMaxToggle from '@/renderer/components/agent/EveMaxToggle';
import { useEveMaxAuthority } from '@renderer/hooks/agent/useEveMaxAuthority';
import { useGuidSend, type GuidSendDeps } from '@/renderer/pages/guid/hooks/useGuidSend';

/** Put main into one of the three states of signed entitlement. */
function mainSays(state: 'unknown' | 'entitled' | 'unentitled'): void {
  if (state === 'unknown') {
    main.receipt = { maxActive: false, wireTier: undefined, laneHold: 'max-entitlement-unknown' };
    selectionHook.state.maxAvailable = false;
    selectionHook.state.maxLocked = true;
    selectionHook.state.maxState = 'locked';
    return;
  }
  if (state === 'entitled') {
    main.receipt = { maxActive: true, wireTier: 'max', laneHold: undefined };
    selectionHook.state.maxAvailable = true;
    selectionHook.state.maxLocked = false;
    selectionHook.state.maxState = 'engaged';
    return;
  }
  // PROVEN unentitled: main sends Standard, and the picker locks with its upsell.
  main.receipt = { maxActive: false, wireTier: 'standard', laneHold: undefined };
  selectionHook.state.maxAvailable = false;
  selectionHook.state.maxLocked = true;
  selectionHook.state.maxState = 'locked';
}

/** Render the toggle inside a real composer surface and wait out the authority read. */
async function renderToggle() {
  const utils = render(
    <div className='sendbox-panel eve-panel eve-composer-surface' data-testid='composer'>
      <div className='unified-send-bar'>
        <EveMaxToggle />
      </div>
    </div>
  );
  await waitFor(() => expect(main.calls).toBeGreaterThan(0));
  const button = (): HTMLElement => screen.getByTestId('eve-max-toggle');
  await waitFor(() => expect(button().getAttribute('data-checking')).toBeTruthy());
  return {
    ...utils,
    button,
    anchor: (): HTMLElement => utils.container.querySelector('.eve-max-toggle-anchor') as HTMLElement,
    composer: (): HTMLElement => screen.getByTestId('composer'),
    hint: (): string => button().getAttribute('aria-label') ?? '',
  };
}

/** A deps bag for the REAL start-screen send funnel. Only the guard is exercised. */
function guidDeps(): GuidSendDeps {
  return {
    input: 'Bitte fasse den Vertrag zusammen',
    setInput: vi.fn(),
    files: [],
    setFiles: vi.fn(),
    dir: '/tmp/workspace',
    setDir: vi.fn(),
    setLoading: vi.fn(),
    loading: false,
    selectedAgent: 'acp',
    selectedAgentKey: 'command-eve',
    selectedAgentInfo: undefined,
    is_presetAgent: true,
    selectedMode: 'ask',
    selectedAcpModel: null,
    currentAcpCachedModelInfo: null,
    current_model: undefined,
    findAgentByKey: vi.fn(() => undefined),
    getEffectiveAgentType: vi.fn(() => ({ agent_type: 'hermes', isAvailable: true })),
    resolvePresetRulesAndSkills: vi.fn().mockResolvedValue({}),
    skillCatalog: {
      mode: 'selection',
      status: 'ready',
      items: [],
      activeItems: [],
      activeCount: 0,
      totalCount: 0,
      selection: {},
    },
    availableMcpServers: [],
    selectedMcpServerIds: [],
    setMentionOpen: vi.fn(),
    setMentionQuery: vi.fn(),
    setMentionSelectorOpen: vi.fn(),
    setMentionActiveIndex: vi.fn(),
    navigate: vi.fn(),
    t: ((key: string) => key) as unknown as GuidSendDeps['t'],
  } as unknown as GuidSendDeps;
}

/** Mount the REAL send funnel and wait out its authority read. */
async function mountSendFunnel() {
  const deps = guidDeps();
  const view = renderHook(() => useGuidSend(deps));
  await waitFor(() => expect(main.calls).toBeGreaterThan(0));
  await waitFor(() => expect(typeof view.result.current.eveSendHeld).toBe('boolean'));
  return { view, deps };
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  main.calls = 0;
  configGetMock.mockImplementation((key: string) =>
    key === 'commandEve.inferenceSelection' ? MAX_SELECTION : undefined
  );
  selectionHook.state.maxEngaged = true;
  activeLocale.bundle = DE;
  mainSays('unknown');
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  vi.clearAllMocks();
});

describe('(a) UNKNOWN — neutral paint, held submission, MAX never claimed', () => {
  it('does NOT paint MAX and does NOT dress the control up as Standard', async () => {
    const { button, anchor, composer } = await renderToggle();

    // Not MAX: the composer glow is the claim that needs proof, and there is none.
    expect(composer().hasAttribute('data-eve-max')).toBe(false);
    expect(button().getAttribute('data-active')).toBe('false');
    expect(button().getAttribute('aria-pressed')).toBe('false');

    // ...and not the locked/upsell story either. That state asserts a KNOWN answer
    // ("you are not entitled, here is what to buy"); unknown has no answer to give.
    // A fourth stamped state is the point — reusing `locked` would be a claim.
    expect(anchor().getAttribute('data-eve-max-state')).toBe('checking');
    expect(anchor().getAttribute('data-eve-max-state')).not.toBe('locked');
    expect(anchor().getAttribute('data-eve-max-state')).not.toBe('available');
    expect(button().getAttribute('data-checking')).toBe('true');

    // ...and it is not wearing the LOCKED attribute either. This is the one the
    // stylesheet actually keys on: `UnifiedSendBar.css` mutes
    // `[data-locked='true']` to 64% to mark the not-entitled answer. While the
    // attribute was stamped from `maxLocked` alone it was true during checking, so
    // the neutral pill silently wore the locked treatment — the separation the
    // component comment claims was asserted in prose and implemented nowhere.
    expect(button().getAttribute('data-locked'), 'checking must not wear the locked style').toBe('false');
  });

  it('shows the NEUTRAL copy — the shipped de-DE string, not an invented one', async () => {
    const { hint } = await renderToggle();

    expect(lookup(DE, 'conversation.eveMax.checkingHint')).toBe('Berechtigung wird geprüft');
    expect(hint()).toContain('Berechtigung wird geprüft');

    // It must NOT be wearing either entitlement answer's words.
    expect(hint()).not.toContain(lookup(DE, 'conversation.eveMax.engagedHint'));
    expect(hint()).not.toContain(lookup(DE, 'conversation.eveMax.lockedEngagedHint'));
    expect(hint()).not.toContain(lookup(DE, 'conversation.eveMax.lockedHint'));
  });

  it('the en-US copy exists and is an equivalent, non-provider sentence', async () => {
    activeLocale.bundle = EN;
    const { hint } = await renderToggle();

    const en = lookup(EN, 'conversation.eveMax.checkingHint');
    expect(en, 'en-US must define the key — no defaultValue twin standing in').toBeTruthy();
    expect(en).toBe('Checking your entitlement');
    expect(hint()).toContain(en as string);
    // Non-provider in BOTH locales.
    for (const copy of [lookup(DE, 'conversation.eveMax.checkingHint'), en]) {
      expect(copy).not.toMatch(/[a-z0-9]+\/[a-z0-9.-]+/i);
      for (const forbidden of ['deepseek', 'glm', 'gemini', 'flash', 'ollama', 'gemma', 'openrouter', 'anthropic']) {
        expect((copy as string).toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it('HOLDS submission — the send funnel refuses, button and keyboard alike', async () => {
    const { view, deps } = await mountSendFunnel();

    expect(view.result.current.eveSendHeld).toBe(true);
    // The BUTTON is disabled...
    expect(view.result.current.isButtonDisabled).toBe(true);
    // ...and the funnel itself refuses, which is what the Enter key calls directly.
    // Guarding only the button would let the keyboard walk straight past the hold.
    view.result.current.sendMessageHandler();
    expect(deps.setLoading, 'a held composer must not start a turn').not.toHaveBeenCalled();
  });

  it('HOLDS the EXPORTED handleSend too, not merely its wrapper', async () => {
    // `sendMessageHandler` is a WRAPPER. `handleSend` is returned from the hook and
    // is therefore directly callable by anything holding the result — and several
    // committed tests in tests/unit/renderer/useGuidSend.dom.test.ts do exactly
    // that. A guard that lives only in the wrapper protects the wrapper's callers,
    // not the exported entry point, so the hold has to be on the function that
    // actually starts the turn.
    const { view, deps } = await mountSendFunnel();

    expect(view.result.current.eveSendHeld).toBe(true);
    const sent = await view.result.current.handleSend();

    expect(sent, 'a held handleSend must report that nothing was sent').toBe(false);
    expect(deps.setLoading).not.toHaveBeenCalled();
    // And it must not have taken a single step of the send path: the very first
    // thing an unheld turn does is ask main for a gate decision.
    const { ipcBridge } = await import('@/common');
    expect(
      vi.mocked(ipcBridge.commandEve.evaluateGateDecision.invoke),
      'a held turn must not even open the gate'
    ).not.toHaveBeenCalled();
  });
});

describe('(b) UNKNOWN → TRUE — paints MAX and submission runs', () => {
  it('paints the composer MAX once main proves the entitlement', async () => {
    const first = await renderToggle();
    expect(first.composer().hasAttribute('data-eve-max')).toBe(false);
    first.unmount();

    mainSays('entitled');
    main.calls = 0;
    const { button, anchor, composer, hint } = await renderToggle();

    expect(composer().getAttribute('data-eve-max')).toBe('true');
    expect(button().getAttribute('data-active')).toBe('true');
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(button().getAttribute('data-checking')).toBe('false');
    expect(anchor().getAttribute('data-eve-max-state')).not.toBe('checking');
    expect(hint()).toContain(lookup(DE, 'conversation.eveMax.engagedHint'));
  });

  it('submission is not held', async () => {
    mainSays('entitled');
    const { view, deps } = await mountSendFunnel();

    expect(view.result.current.eveSendHeld).toBe(false);
    expect(view.result.current.isButtonDisabled).toBe(false);
    view.result.current.sendMessageHandler();
    await waitFor(() => expect(deps.setLoading).toHaveBeenCalledWith(true));
  });

  it('the EXPORTED handleSend runs again — the guard is a hold, not an off switch', async () => {
    // The other half of the guard on `handleSend`: proving it refuses is only half
    // an answer if it refuses everything.
    mainSays('entitled');
    const { view } = await mountSendFunnel();
    const { ipcBridge } = await import('@/common');

    await view.result.current.handleSend();
    expect(vi.mocked(ipcBridge.commandEve.evaluateGateDecision.invoke)).toHaveBeenCalled();
  });
});

describe('(c) UNKNOWN → FALSE — Standard, with copy that says why and names no provider', () => {
  it('drops the neutral state, refuses to paint MAX, and explains the fallback', async () => {
    const first = await renderToggle();
    expect(first.button().getAttribute('data-checking')).toBe('true');
    first.unmount();

    mainSays('unentitled');
    main.calls = 0;
    const { button, anchor, composer, hint } = await renderToggle();

    // Standard: no glow, no MAX claim, and no longer "checking".
    expect(composer().hasAttribute('data-eve-max')).toBe(false);
    expect(button().getAttribute('data-active')).toBe('false');
    expect(button().getAttribute('data-checking')).toBe('false');
    expect(anchor().getAttribute('data-eve-max-state')).toBe('locked');
    // The other half: a KNOWN "not entitled" still carries the locked attribute,
    // so the muted upsell styling still applies where it is honest.
    expect(button().getAttribute('data-locked')).toBe('true');

    // The copy says WHY, and keeps the user's intent visible.
    const why = lookup(DE, 'conversation.eveMax.lockedEngagedHint') as string;
    expect(hint()).toContain(why);
    expect(hint()).not.toContain('Berechtigung wird geprüft');

    // NON-PROVIDER — the hard scrub contract this repo already holds elsewhere.
    const rendered = `${button().outerHTML} ${hint()}`;
    expect(rendered).not.toMatch(/\b[a-z0-9]{3,}\/[a-z0-9.-]{2,}\b/i);
    for (const forbidden of ['deepseek', 'glm-', 'gemini', 'flash', 'ollama', 'gemma', 'openrouter', 'anthropic']) {
      expect(rendered.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('submission is RESTORED — a proven-unentitled seat still sends', async () => {
    mainSays('unentitled');
    const { view, deps } = await mountSendFunnel();

    // The whole point of the non-brick fallback: FALSE is an answer, not a hold.
    expect(view.result.current.eveSendHeld).toBe(false);
    expect(view.result.current.isButtonDisabled).toBe(false);
    view.result.current.sendMessageHandler();
    await waitFor(() => expect(deps.setLoading).toHaveBeenCalledWith(true));
  });
});

describe('(d) the persisted MAX intent stays visible through the whole sequence', () => {
  it('the control keeps showing what the user chose, in every entitlement state', async () => {
    // WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY NO LONGER CLAIMS.
    //
    // This block used to be titled "the persisted MAX selection survives" and
    // ended by asserting that nothing ever called
    // `configService.set('commandEve.inferenceSelection', …)`. It could not
    // honestly assert that: `useEveInferenceSelection` — the hook that owns EVERY
    // write to that key — is replaced by `vi.mock` at the top of this file, so the
    // production writers never ran. The assertion was true of a mock, and deleting
    // the real guard could not turn it red. It was a green gate over a path the
    // product does not take.
    //
    // The persistence property now lives in
    // `eveInferenceSelectionUnknownWrite.dom.test.tsx`, which renders the REAL
    // hook and observes the REAL config writes. What is left here is the thing
    // this file can actually see: the PAINT. Intent stays legible on the control
    // the user pressed, in all three states.
    const intentSurvives = async (state: Parameters<typeof mainSays>[0]) => {
      mainSays(state);
      main.calls = 0;
      const view = await renderToggle();
      expect(view.button().getAttribute('data-engaged'), `intent lost in state: ${state}`).toBe('true');
      view.unmount();
    };

    await intentSurvives('unknown');
    await intentSurvives('entitled');
    await intentSurvives('unentitled');
    await intentSurvives('unknown');
  });
});

describe('the hold cannot be invented by the surface', () => {
  it('a receipt for ANOTHER seat neither paints nor holds', async () => {
    // A hold is only honest when it is about the seat in front of the user. Main
    // still refuses the turn either way, so an unbound receipt must not brick a
    // composer it does not describe.
    const bridge = await import('@/common/adapter/ipcBridge');
    vi.mocked(bridge.commandEve.inferenceLaneDecision.invoke).mockImplementation(async () => {
      main.calls += 1;
      return {
        success: true,
        data: {
          seatId: 'seat-someone-else',
          seatContextRevision: REVISION,
          maxActive: true,
          laneHold: 'max-entitlement-unknown' as const,
        },
      };
    });

    const view = renderHook(() => useEveMaxAuthority());
    await waitFor(() => expect(main.calls).toBeGreaterThan(0));
    await waitFor(() => expect(view.result.current.state.status).toBe('ready'));

    expect(view.result.current.maxActive, 'a foreign receipt must not paint').toBe(false);
    expect(view.result.current.entitlementPending, 'a foreign receipt must not hold').toBe(false);
  });

  it('loading and error states hold nothing — main stays the spend gate', async () => {
    const bridge = await import('@/common/adapter/ipcBridge');
    vi.mocked(bridge.commandEve.inferenceLaneDecision.invoke).mockImplementation(async () => {
      main.calls += 1;
      return { success: false, data: undefined } as never;
    });

    const view = renderHook(() => useEveMaxAuthority());
    await waitFor(() => expect(view.result.current.state.status).toBe('error'));
    expect(view.result.current.maxActive).toBe(false);
    expect(view.result.current.entitlementPending).toBe(false);
  });
});
