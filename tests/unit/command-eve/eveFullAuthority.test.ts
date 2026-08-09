/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * "Full release for this machine" — the one act that means "this box is mine,
 * get on with it".
 *
 * WHAT THIS SUITE IS ACTUALLY GUARDING. The easy way to build this feature is a
 * seventh rung, and the easy way to TEST it is to assert the fields it writes.
 * Both are wrong in the same way: they check the shape of the act instead of the
 * property that makes it safe to offer at all.
 *
 * The property is that a full release is a COMPOSITION of the controls a human
 * could operate one at a time — so it can never grant something no individual
 * control could grant, and can never skip the bookkeeping those controls do.
 * `full_release_equals_the_hand_assembled_grant` builds the same grant by hand
 * and demands the two are indistinguishable.
 *
 * WHAT THAT TEST DOES AND DOES NOT CATCH, stated precisely because the first
 * version of this paragraph overstated it. `toStrictEqual` is a VALUE
 * comparison, so it cannot detect that a re-implementation is a literal. What
 * it catches is a re-implementation whose value DRIFTS from the composed one —
 * in practice the easy omission, the per-seal `grantedAt` bookkeeping that
 * `withSeal` does and a hand-rolled object forgets. A literal that reproduces
 * every field exactly would pass, and would also be correct.
 */

import { describe, expect, it } from 'vitest';
import {
  decideCommandApproval,
  decideHermesToolApproval,
  renderEveAuthorityRuntime,
} from '@/common/config/eveAuthorityRuntimeCore';
import {
  EVE_SEALED_CAPABILITIES,
  grantAllows,
  type EveAuthorityGrant,
  type EveSealedCapability,
} from '@/common/config/eveAuthorityCore';
import {
  FULL_AUTHORITY_RUNG,
  HIGH_DAILY_BUDGET_CENTS,
  grantNeedsAttention,
  isFullAuthority,
  previewFullAuthority,
  withDailyBudget,
  withLadder,
  withOpaqueUiAutoRun,
  withSeal,
  withFullAuthority,
} from '@/common/config/eveAuthorityStoreCore';

const NOW = '2026-08-08T09:00:00.000Z';

const FAIL_CLOSED: EveAuthorityGrant = { ladder: 1, capabilities: {}, updatedBy: 'migration' };

describe('full release — the act itself', () => {
  it('lands on rung 5 and opens every seal, in one call', () => {
    const next = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, 'allow', NOW);

    expect(next.ladder).toBe(FULL_AUTHORITY_RUNG);
    for (const capability of EVE_SEALED_CAPABILITIES) {
      expect(next.capabilities[capability]).toBe(true);
    }
    expect(next.limits?.['spend.money']?.dailyCents).toBe(5_000);
    expect(next.opaqueUiAutoRun).toBe(true);
    expect(next.opaqueUiAutoRunGrantedAt).toBe(NOW);
    expect(next.updatedBy).toBe('user');
  });

  it('records WHEN each seal was opened, so the grant stays reviewable', () => {
    // A rung-shaped "everything" would carry no dates at all. That is one of the
    // reasons this is not a seventh rung, so it is worth pinning here.
    const next = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, 'allow', NOW);
    for (const capability of EVE_SEALED_CAPABILITIES) {
      expect(next.grantedAt?.[capability]).toBe(NOW);
    }
  });

  it('full_release_equals_the_hand_assembled_grant', () => {
    // The load-bearing test. Same end state, built the long way — the way a
    // human clicking seven controls would build it.
    let byHand: EveAuthorityGrant = withLadder(FAIL_CLOSED, FULL_AUTHORITY_RUNG);
    for (const capability of EVE_SEALED_CAPABILITIES) byHand = withSeal(byHand, capability, true, NOW);
    byHand = withDailyBudget(byHand, 5_000);
    byHand = withOpaqueUiAutoRun(byHand, true, NOW);

    const inOneAct = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, 'allow', NOW);

    expect(inOneAct).toStrictEqual(byHand);
  });

  it('leaves the runtime actually able to act — not merely recorded as able', () => {
    const next = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, 'allow', NOW);

    expect(grantAllows({ class: 'irreversible' }, next)).toBe(true);
    expect(grantAllows({ class: 'reversible_outside' }, next)).toBe(true);
    expect(grantAllows({ class: 'workspace_command' }, next)).toBe(true);
    expect(grantAllows({ class: 'irreversible', sealed: 'spend.money', amountCents: 4_999 }, next)).toBe(true);
    expect(grantNeedsAttention(next)).toBeNull();
  });

  it('still refuses what no grant may ever cover', () => {
    // The ceiling went all the way up; `unclassified` is still not admitted, at
    // any rung, by design (eveAuthorityCore: "unknown is not harmless").
    const next = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, 'allow', NOW);
    expect(grantAllows({ class: 'unclassified' }, next)).toBe(false);
    expect(grantAllows({ class: 'unclassified', opaqueUiAction: true }, next)).toBe(true);
  });
});

describe('full release — money stays bound to a number', () => {
  it('refuses the WHOLE act when the budget is not a budget', () => {
    // All or nothing. A half-applied full release is a grant nobody chose, and
    // the human cannot tell which half landed.
    for (const bad of [0, -1, 12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const next = withFullAuthority(FAIL_CLOSED, { dailyCents: bad }, 'allow', NOW);
      expect(next).toStrictEqual(FAIL_CLOSED);
    }
  });

  it('never opens money without a ceiling, even by the one-click path', () => {
    const next = withFullAuthority(FAIL_CLOSED, 'keep-sealed', 'allow', NOW);

    expect(next.capabilities['spend.money']).toBeUndefined();
    expect(grantAllows({ class: 'irreversible', sealed: 'spend.money', amountCents: 1 }, next)).toBe(false);
    // ...and the state it produced is coherent, not the "switch on, spends
    // nothing" shape `grantNeedsAttention` exists to report.
    expect(grantNeedsAttention(next)).toBeNull();
  });

  it('opens the other four when money is left out', () => {
    const next = withFullAuthority(FAIL_CLOSED, 'keep-sealed', 'allow', NOW);
    const others = EVE_SEALED_CAPABILITIES.filter((c) => c !== 'spend.money');
    for (const capability of others) expect(next.capabilities[capability]).toBe(true);
    expect(next.ladder).toBe(FULL_AUTHORITY_RUNG);
    const runtime = renderEveAuthorityRuntime(next);
    expect(decideHermesToolApproval({ toolName: 'browser_click' }, runtime)).toBe('allow');
    expect(decideCommandApproval({ command: 'stripe charge', insideWorkspace: true }, runtime)).toBe('ask');
  });

  it('a high budget is stored, not silently clamped', () => {
    // `classifyDailyBudget` answers 'confirm', not 'invalid'. The panel warns;
    // the act still honours what the human typed.
    const high = HIGH_DAILY_BUDGET_CENTS + 1;
    const next = withFullAuthority(FAIL_CLOSED, { dailyCents: high }, 'allow', NOW);
    expect(next.limits?.['spend.money']?.dailyCents).toBe(high);
  });

  it('does not CLOSE a money seal the human already opened', () => {
    // A release raises a ceiling. It is not a channel for taking something back.
    let open = withSeal(FAIL_CLOSED, 'spend.money', true, '2026-01-01T00:00:00.000Z');
    open = withDailyBudget(open, 2_000);

    const next = withFullAuthority(open, 'keep-sealed', 'allow', NOW);

    expect(next.capabilities['spend.money']).toBe(true);
    expect(next.limits?.['spend.money']?.dailyCents).toBe(2_000);
    // ...and the original grant date survives, because that seal was not re-opened.
    expect(next.grantedAt?.['spend.money']).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('the confirmation can name what it is about to do', () => {
  it('lists the seals that would open, and separately the ones already open', () => {
    const partly = withSeal(FAIL_CLOSED, 'publish.outward', true, '2026-01-01T00:00:00.000Z');

    const preview = previewFullAuthority(partly, { dailyCents: 5_000 }, 'allow');

    expect(preview.sealsAlreadyOpen).toStrictEqual(['publish.outward']);
    expect([...preview.sealsToOpen].sort()).toStrictEqual(
      EVE_SEALED_CAPABILITIES.filter((c) => c !== 'publish.outward')
        .slice()
        .sort()
    );
    expect(preview.ladderFrom).toBe(1);
    expect(preview.ladderTo).toBe(FULL_AUTHORITY_RUNG);
    expect(preview.ladderChanges).toBe(true);
    expect(preview.opaqueUiAutoRunWillEnable).toBe(true);
    expect(preview.blocked).toBeNull();
  });

  it('the preview and the act agree about money being left out', () => {
    const preview = previewFullAuthority(FAIL_CLOSED, 'keep-sealed', 'keep-asking');

    expect(preview.moneyLeftAsIs).toBe(true);
    expect(preview.dailyCents).toBeNull();
    expect(preview.sealsToOpen).not.toContain('spend.money' as EveSealedCapability);
    expect(preview.opaqueUiAutoRunLeftAsIs).toBe(true);

    const applied = withFullAuthority(FAIL_CLOSED, 'keep-sealed', 'keep-asking', NOW);
    expect(applied.capabilities['spend.money']).toBeUndefined();
    expect(applied.opaqueUiAutoRun).toBeUndefined();
  });

  it('keeps asking when a paused stored UI override is switched off before Full Release', () => {
    const paused = {
      ...FAIL_CLOSED,
      ladder: 3,
      opaqueUiAutoRun: true,
      opaqueUiAutoRunGrantedAt: '2026-01-01T00:00:00.000Z',
    } satisfies EveAuthorityGrant;

    expect(grantAllows({ class: 'unclassified', opaqueUiAction: true }, paused)).toBe(false);

    const preview = previewFullAuthority(paused, 'keep-sealed', 'keep-asking');
    expect(preview.opaqueUiAutoRunWillDisable).toBe(true);
    expect(preview.opaqueUiAutoRunLeftAsIs).toBe(false);
    expect(preview.changesNothing).toBe(false);

    const applied = withFullAuthority(paused, 'keep-sealed', 'keep-asking', NOW);
    expect(applied.ladder).toBe(FULL_AUTHORITY_RUNG);
    expect(applied.opaqueUiAutoRun).toBeUndefined();
    expect(applied.opaqueUiAutoRunGrantedAt).toBeUndefined();
    expect(grantAllows({ class: 'unclassified', opaqueUiAction: true }, applied)).toBe(false);
  });

  it('says so when the button would change nothing', () => {
    const already = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, 'allow', NOW);

    const preview = previewFullAuthority(already, { dailyCents: 5_000 }, 'allow');

    expect(preview.changesNothing).toBe(true);
    expect(preview.sealsToOpen).toStrictEqual([]);
    expect(preview.ladderChanges).toBe(false);
    expect(preview.budgetChanges).toBe(false);
  });

  it('reports the block rather than pretending the act is available', () => {
    const preview = previewFullAuthority(FAIL_CLOSED, { dailyCents: 0 }, 'allow');

    expect(preview.blocked).toBe('invalid-budget');
    expect(preview.changesNothing).toBe(false);
  });

  it('a preview that promises a change is a change the act delivers', () => {
    // The two must not drift: anything `sealsToOpen` names has to come back open.
    const partly = withSeal(FAIL_CLOSED, 'delete.outside', true, '2026-01-01T00:00:00.000Z');
    const preview = previewFullAuthority(partly, { dailyCents: 750 }, 'allow');
    const applied = withFullAuthority(partly, { dailyCents: 750 }, 'allow', NOW);

    for (const capability of preview.sealsToOpen) {
      expect(applied.capabilities[capability]).toBe(true);
    }
    expect(applied.ladder).toBe(preview.ladderTo);
    expect(applied.limits?.['spend.money']?.dailyCents).toBe(preview.dailyCents);
  });
});

describe('isFullAuthority — only true when the runtime would agree', () => {
  it('is true after a full release with a budget', () => {
    expect(isFullAuthority(withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, 'allow', NOW))).toBe(true);
  });

  it('does not silently promote an old five-seal Full grant to opaque UI auto-run', () => {
    let legacyFull: EveAuthorityGrant = withLadder(FAIL_CLOSED, FULL_AUTHORITY_RUNG);
    for (const capability of EVE_SEALED_CAPABILITIES) legacyFull = withSeal(legacyFull, capability, true, NOW);
    legacyFull = withDailyBudget(legacyFull, 5_000);

    expect(isFullAuthority(legacyFull)).toBe(false);
    expect(renderEveAuthorityRuntime(legacyFull).opaque_ui_autorun).toBe(false);
  });

  it('is false when money is open but has no usable ceiling', () => {
    // The state that spends nothing. Calling it "full" would be the panel
    // promising more than `spendWithinDailyLimit` holds.
    let grant: EveAuthorityGrant = withLadder(FAIL_CLOSED, FULL_AUTHORITY_RUNG);
    for (const capability of EVE_SEALED_CAPABILITIES) grant = withSeal(grant, capability, true, NOW);

    expect(grant.capabilities['spend.money']).toBe(true);
    expect(isFullAuthority(grant)).toBe(false);
    expect(grantNeedsAttention(grant)).toBe('money-without-budget');
  });

  it('is false at rung 5 with the seals still shut', () => {
    expect(isFullAuthority(withLadder(FAIL_CLOSED, FULL_AUTHORITY_RUNG))).toBe(false);
  });

  it('is false when every seal is open but the ladder is not at the top', () => {
    let grant: EveAuthorityGrant = withDailyBudget(FAIL_CLOSED, 5_000);
    for (const capability of EVE_SEALED_CAPABILITIES) grant = withSeal(grant, capability, true, NOW);
    expect(grant.ladder).toBe(1);
    expect(isFullAuthority(grant)).toBe(false);
  });

  it('is false after money is withdrawn again', () => {
    const full = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, 'allow', NOW);
    const withdrawn = withSeal(full, 'spend.money', false, NOW);
    expect(isFullAuthority(withdrawn)).toBe(false);
  });
});

/**
 * AGAINST THE REAL RENDERER, not against panel text.
 *
 * This is the only test in the suite that asks what the RUNTIME receives, and it
 * exists because the panel and the runtime are the two things that must not
 * drift. A confirmation dialog can be made to say anything; `renderEveAuthorityRuntime`
 * is what actually crosses the process boundary.
 *
 * It also pins the money asymmetry deliberately: a reusable boolean cannot
 * prove an operation-specific amount against an atomically persisted daily
 * total. The configured ceiling crosses the boundary as data, but unattended
 * money authority remains false until that metered seam exists.
 */
describe('full release — what the runtime actually receives', () => {
  it('is fully open in every class, and money alone stays shut without a number', () => {
    const released = withFullAuthority(FAIL_CLOSED, 'keep-sealed', 'allow', NOW);
    const runtime = renderEveAuthorityRuntime(released);

    expect(runtime.ladder).toBe(5);
    expect(runtime.edit_policy).toBe('session');
    expect(runtime.workspace_command).toBe(true);
    expect(runtime.outside_workspace_command).toBe(true);
    expect(runtime.irreversible).toBe(true);
    expect(runtime.opaque_ui_autorun).toBe(true);

    for (const capability of EVE_SEALED_CAPABILITIES.filter((c) => c !== 'spend.money')) {
      expect(runtime.seals[capability]).toBe(true);
    }
    expect(runtime.seals['spend.money']).toBe(false);
    expect(runtime.spend_daily_cents).toBe(0);
  });

  it('preserves the configured ceiling without turning it into unattended money authority', () => {
    const released = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, 'allow', NOW);
    const runtime = renderEveAuthorityRuntime(released);

    expect(runtime.seals['spend.money']).toBe(false);
    expect(runtime.spend_daily_cents).toBe(5_000);

    // WHERE THE CEILING WORKS, AND WHY THAT IS NOT ENOUGH.
    //
    // `grantAllows` enforces it correctly when it is handed a real amount: a
    // 5000-cent purchase against a 5000-cent ceiling with nothing spent yet is
    // refused, because `spendWithinDailyLimit` compares the sum. The logic is
    // not the gap.
    //
    // (An earlier version of this comment said the opposite — "an action
    // costing far more than the ceiling is still admitted by the grant" —
    // directly above an assertion of `false`. The assertion was right.)
    expect(grantAllows({ class: 'irreversible', sealed: 'spend.money', amountCents: 500_000 }, released)).toBe(false);
    // The runtime refuses to collapse that amount-dependent decision into a
    // reusable true/false grant. Generic shell and opaque browser operations
    // therefore ask for the concrete operation rather than bypassing the cap.
    expect(runtime.seals['spend.money']).toBe(false);
    expect(Object.keys(runtime.seals)).not.toContain('amountCents');
  });
});
