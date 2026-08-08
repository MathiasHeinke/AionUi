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
import { renderEveAuthorityRuntime } from '@/common/config/eveAuthorityRuntimeCore';
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
  withSeal,
  withFullAuthority,
} from '@/common/config/eveAuthorityStoreCore';

const NOW = '2026-08-08T09:00:00.000Z';

const FAIL_CLOSED: EveAuthorityGrant = { ladder: 1, capabilities: {}, updatedBy: 'migration' };

describe('full release — the act itself', () => {
  it('lands on rung 5 and opens every seal, in one call', () => {
    const next = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, NOW);

    expect(next.ladder).toBe(FULL_AUTHORITY_RUNG);
    for (const capability of EVE_SEALED_CAPABILITIES) {
      expect(next.capabilities[capability]).toBe(true);
    }
    expect(next.limits?.['spend.money']?.dailyCents).toBe(5_000);
    expect(next.updatedBy).toBe('user');
  });

  it('records WHEN each seal was opened, so the grant stays reviewable', () => {
    // A rung-shaped "everything" would carry no dates at all. That is one of the
    // reasons this is not a seventh rung, so it is worth pinning here.
    const next = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, NOW);
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

    const inOneAct = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, NOW);

    expect(inOneAct).toStrictEqual(byHand);
  });

  it('leaves the runtime actually able to act — not merely recorded as able', () => {
    const next = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, NOW);

    expect(grantAllows({ class: 'irreversible' }, next)).toBe(true);
    expect(grantAllows({ class: 'reversible_outside' }, next)).toBe(true);
    expect(grantAllows({ class: 'workspace_command' }, next)).toBe(true);
    expect(grantAllows({ class: 'irreversible', sealed: 'spend.money', amountCents: 4_999 }, next)).toBe(true);
    expect(grantNeedsAttention(next)).toBeNull();
  });

  it('still refuses what no grant may ever cover', () => {
    // The ceiling went all the way up; `unclassified` is still not admitted, at
    // any rung, by design (eveAuthorityCore: "unknown is not harmless").
    const next = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, NOW);
    expect(grantAllows({ class: 'unclassified' }, next)).toBe(false);
  });
});

describe('full release — money stays bound to a number', () => {
  it('refuses the WHOLE act when the budget is not a budget', () => {
    // All or nothing. A half-applied full release is a grant nobody chose, and
    // the human cannot tell which half landed.
    for (const bad of [0, -1, 12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const next = withFullAuthority(FAIL_CLOSED, { dailyCents: bad }, NOW);
      expect(next).toStrictEqual(FAIL_CLOSED);
    }
  });

  it('never opens money without a ceiling, even by the one-click path', () => {
    const next = withFullAuthority(FAIL_CLOSED, 'keep-sealed', NOW);

    expect(next.capabilities['spend.money']).toBeUndefined();
    expect(grantAllows({ class: 'irreversible', sealed: 'spend.money', amountCents: 1 }, next)).toBe(false);
    // ...and the state it produced is coherent, not the "switch on, spends
    // nothing" shape `grantNeedsAttention` exists to report.
    expect(grantNeedsAttention(next)).toBeNull();
  });

  it('opens the other four when money is left out', () => {
    const next = withFullAuthority(FAIL_CLOSED, 'keep-sealed', NOW);
    const others = EVE_SEALED_CAPABILITIES.filter((c) => c !== 'spend.money');
    for (const capability of others) expect(next.capabilities[capability]).toBe(true);
    expect(next.ladder).toBe(FULL_AUTHORITY_RUNG);
  });

  it('a high budget is stored, not silently clamped', () => {
    // `classifyDailyBudget` answers 'confirm', not 'invalid'. The panel warns;
    // the act still honours what the human typed.
    const high = HIGH_DAILY_BUDGET_CENTS + 1;
    const next = withFullAuthority(FAIL_CLOSED, { dailyCents: high }, NOW);
    expect(next.limits?.['spend.money']?.dailyCents).toBe(high);
  });

  it('does not CLOSE a money seal the human already opened', () => {
    // A release raises a ceiling. It is not a channel for taking something back.
    let open = withSeal(FAIL_CLOSED, 'spend.money', true, '2026-01-01T00:00:00.000Z');
    open = withDailyBudget(open, 2_000);

    const next = withFullAuthority(open, 'keep-sealed', NOW);

    expect(next.capabilities['spend.money']).toBe(true);
    expect(next.limits?.['spend.money']?.dailyCents).toBe(2_000);
    // ...and the original grant date survives, because that seal was not re-opened.
    expect(next.grantedAt?.['spend.money']).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('the confirmation can name what it is about to do', () => {
  it('lists the seals that would open, and separately the ones already open', () => {
    const partly = withSeal(FAIL_CLOSED, 'publish.outward', true, '2026-01-01T00:00:00.000Z');

    const preview = previewFullAuthority(partly, { dailyCents: 5_000 });

    expect(preview.sealsAlreadyOpen).toStrictEqual(['publish.outward']);
    expect([...preview.sealsToOpen].sort()).toStrictEqual(
      EVE_SEALED_CAPABILITIES.filter((c) => c !== 'publish.outward')
        .slice()
        .sort()
    );
    expect(preview.ladderFrom).toBe(1);
    expect(preview.ladderTo).toBe(FULL_AUTHORITY_RUNG);
    expect(preview.ladderChanges).toBe(true);
    expect(preview.blocked).toBeNull();
  });

  it('the preview and the act agree about money being left out', () => {
    const preview = previewFullAuthority(FAIL_CLOSED, 'keep-sealed');

    expect(preview.moneyLeftAsIs).toBe(true);
    expect(preview.dailyCents).toBeNull();
    expect(preview.sealsToOpen).not.toContain('spend.money' as EveSealedCapability);

    const applied = withFullAuthority(FAIL_CLOSED, 'keep-sealed', NOW);
    expect(applied.capabilities['spend.money']).toBeUndefined();
  });

  it('says so when the button would change nothing', () => {
    const already = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, NOW);

    const preview = previewFullAuthority(already, { dailyCents: 5_000 });

    expect(preview.changesNothing).toBe(true);
    expect(preview.sealsToOpen).toStrictEqual([]);
    expect(preview.ladderChanges).toBe(false);
    expect(preview.budgetChanges).toBe(false);
  });

  it('reports the block rather than pretending the act is available', () => {
    const preview = previewFullAuthority(FAIL_CLOSED, { dailyCents: 0 });

    expect(preview.blocked).toBe('invalid-budget');
    expect(preview.changesNothing).toBe(false);
  });

  it('a preview that promises a change is a change the act delivers', () => {
    // The two must not drift: anything `sealsToOpen` names has to come back open.
    const partly = withSeal(FAIL_CLOSED, 'delete.outside', true, '2026-01-01T00:00:00.000Z');
    const preview = previewFullAuthority(partly, { dailyCents: 750 });
    const applied = withFullAuthority(partly, { dailyCents: 750 }, NOW);

    for (const capability of preview.sealsToOpen) {
      expect(applied.capabilities[capability]).toBe(true);
    }
    expect(applied.ladder).toBe(preview.ladderTo);
    expect(applied.limits?.['spend.money']?.dailyCents).toBe(preview.dailyCents);
  });
});

describe('isFullAuthority — only true when the runtime would agree', () => {
  it('is true after a full release with a budget', () => {
    expect(isFullAuthority(withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, NOW))).toBe(true);
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
    const full = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, NOW);
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
 * It also pins the money asymmetry deliberately, because it is the one place a
 * full release is NOT full: `sealUsable` probes with a hardcoded `amountCents: 0`
 * (eveAuthorityRuntimeCore:84), so a positive `dailyCents` is the whole
 * condition for `seals['spend.money']`. Which means the number functions as the
 * ON-SWITCH for that seal — no production path ever compares a real amount
 * against it. If someone later wires actual spend accounting, this test is where
 * the assumption is written down.
 */
describe('full release — what the runtime actually receives', () => {
  it('is fully open in every class, and money alone stays shut without a number', () => {
    const released = withFullAuthority(FAIL_CLOSED, 'keep-sealed', NOW);
    const runtime = renderEveAuthorityRuntime(released);

    expect(runtime.ladder).toBe(5);
    expect(runtime.edit_policy).toBe('session');
    expect(runtime.workspace_command).toBe(true);
    expect(runtime.outside_workspace_command).toBe(true);
    expect(runtime.irreversible).toBe(true);

    for (const capability of EVE_SEALED_CAPABILITIES.filter((c) => c !== 'spend.money')) {
      expect(runtime.seals[capability]).toBe(true);
    }
    expect(runtime.seals['spend.money']).toBe(false);
    expect(runtime.spend_daily_cents).toBe(0);
  });

  it('naming a number is what opens the money seal — that is all the number does today', () => {
    const released = withFullAuthority(FAIL_CLOSED, { dailyCents: 5_000 }, NOW);
    const runtime = renderEveAuthorityRuntime(released);

    expect(runtime.seals['spend.money']).toBe(true);
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
    // The gap is that nothing ever reaches that branch. The only probe in
    // production passes a hardcoded `amountCents: 0`
    // (eveAuthorityRuntimeCore:84), and what the wheel is handed is one
    // boolean, already true, with no amount attached. Working enforcement that
    // is never called is indistinguishable from no enforcement.
    expect(runtime.seals['spend.money']).toBe(true);
    expect(Object.keys(runtime.seals)).not.toContain('amountCents');
  });
});
