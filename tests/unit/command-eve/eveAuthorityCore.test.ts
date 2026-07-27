import { describe, expect, it } from 'vitest';

import {
  BURST_ESCALATION_THRESHOLD,
  EVE_AUTHORITY_FAIL_CLOSED,
  EVE_LADDER_RUNGS,
  EVE_SEALED_CAPABILITIES,
  decideAuthority,
  grantAllows,
  isEveAuthorityGrant,
  ladderFromLegacyMode,
  mayOfferToAct,
  migrateLegacyGrant,
  readEveAuthorityGrant,
  type EveAction,
  type EveActionClass,
  type EveAuthorityGrant,
  type EveJudgmentSignals,
  type EveLadderRung,
  type EveSealedCapability,
} from '@/common/config/eveAuthorityCore';

const ACTION_CLASSES: EveActionClass[] = [
  'read',
  'workspace_edit',
  'workspace_command',
  'reversible_outside',
  'irreversible',
  'unclassified',
];

const SIGNAL_CASES: (EveJudgmentSignals | undefined)[] = [
  undefined,
  {},
  { offTask: true },
  { riskPattern: 'rm -rf' },
  { outsideWorkspace: true },
  { firstSealedUseInSession: true },
  { burstCount: BURST_ESCALATION_THRESHOLD + 1 },
  { outsideWorkspace: true, riskPattern: 'osascript', offTask: true, burstCount: 99 },
];

/** Every combination of sealed capabilities being on or off. */
function allCapabilitySets(): Partial<Record<EveSealedCapability, boolean>>[] {
  const sets: Partial<Record<EveSealedCapability, boolean>>[] = [];
  for (let mask = 0; mask < 1 << EVE_SEALED_CAPABILITIES.length; mask += 1) {
    const set: Partial<Record<EveSealedCapability, boolean>> = {};
    EVE_SEALED_CAPABILITIES.forEach((capability, index) => {
      set[capability] = Boolean(mask & (1 << index));
    });
    sets.push(set);
  }
  return sets;
}

function allGrants(): EveAuthorityGrant[] {
  const grants: EveAuthorityGrant[] = [];
  for (const ladder of EVE_LADDER_RUNGS) {
    for (const capabilities of allCapabilitySets()) {
      grants.push({ ladder, capabilities, updatedBy: 'user' });
    }
  }
  return grants;
}

function allActions(): EveAction[] {
  const actions: EveAction[] = [];
  for (const actionClass of ACTION_CLASSES) {
    actions.push({ class: actionClass });
    for (const sealed of EVE_SEALED_CAPABILITIES) {
      actions.push({ class: actionClass, sealed });
    }
  }
  return actions;
}

describe('the grant is a ceiling, never a floor', () => {
  it('judgment never widens a grant — exhaustively', () => {
    const grants = allGrants();
    const actions = allActions();
    let checked = 0;
    let allowed = 0;

    for (const grant of grants) {
      for (const action of actions) {
        const ceiling = grantAllows(action, grant);
        for (const signals of SIGNAL_CASES) {
          const outcome = decideAuthority(action, grant, signals);
          checked += 1;
          if (outcome.decision === 'allow') {
            allowed += 1;
            // THE invariant. If this ever fails, the judgment layer has become a
            // privilege-escalation path and the whole design is unsound.
            expect(
              ceiling,
              `decideAuthority allowed ${action.class}/${action.sealed ?? 'none'} at rung ${grant.ladder} ` +
                `which grantAllows() refuses (signals: ${JSON.stringify(signals)})`
            ).toBe(true);
          }
          if (!ceiling) {
            expect(outcome.decision).toBe('ask');
          }
        }
      }
    }

    // Guard the guard: a test that checked nothing would also pass every assertion.
    expect(checked).toBeGreaterThan(5000);
    expect(allowed).toBeGreaterThan(0);
  });

  it('every escalation carries a reason the user can read', () => {
    for (const grant of allGrants()) {
      for (const action of allActions()) {
        for (const signals of SIGNAL_CASES) {
          const outcome = decideAuthority(action, grant, signals);
          if (outcome.decision === 'ask') {
            expect(outcome.reason.length).toBeGreaterThan(0);
          } else {
            expect(outcome.escalated).toBe(false);
          }
        }
      }
    }
  });
});

describe('the sealed set never hangs off a rung', () => {
  it('rung 5 permits irreversible work but no sealed capability', () => {
    const full: EveAuthorityGrant = { ladder: 5, capabilities: {}, updatedBy: 'user' };
    expect(grantAllows({ class: 'irreversible' }, full)).toBe(true);
    for (const sealed of EVE_SEALED_CAPABILITIES) {
      expect(grantAllows({ class: 'irreversible', sealed }, full)).toBe(false);
    }
  });

  it('unsealing money does not hand over rung-5 behaviour', () => {
    const routineWithMoney: EveAuthorityGrant = {
      ladder: 2,
      capabilities: { 'spend.money': true },
      limits: { 'spend.money': { dailyCents: 5000 } },
      updatedBy: 'user',
    };
    // The budget works at rung 2 — "fifty euros a day" is not a claim about files.
    expect(grantAllows({ class: 'irreversible', sealed: 'spend.money', amountCents: 100 }, routineWithMoney)).toBe(
      true
    );
    // But it buys nothing beyond itself: rung 2 still refuses irreversible work,
    // and an open seal does not leak into its neighbours.
    expect(grantAllows({ class: 'irreversible' }, routineWithMoney)).toBe(false);
    expect(grantAllows({ class: 'irreversible', sealed: 'publish.outward' }, routineWithMoney)).toBe(false);
  });

  it('rung 0 is the hard off-switch even for an open seal', () => {
    const watchWithEverything: EveAuthorityGrant = {
      ladder: 0,
      capabilities: Object.fromEntries(EVE_SEALED_CAPABILITIES.map((c) => [c, true])),
      limits: { 'spend.money': { dailyCents: 100000 } },
      updatedBy: 'user',
    };
    expect(grantAllows({ class: 'read' }, watchWithEverything)).toBe(true);
    for (const sealed of EVE_SEALED_CAPABILITIES) {
      expect(
        grantAllows({ class: 'irreversible', sealed, amountCents: 1 }, watchWithEverything),
        `${sealed} must not act through rung 0`
      ).toBe(false);
    }
  });
});

const withBudget = (dailyCents: number): EveAuthorityGrant => ({
  ladder: 3,
  capabilities: { 'spend.money': true },
  limits: { 'spend.money': { dailyCents } },
  updatedBy: 'user',
});

describe('money is the seal that is not a boolean', () => {
  it('spends inside the daily ceiling and stops at it', () => {
    const grant = withBudget(5000); // 50 EUR
    const spend = (amountCents: number, spentTodayCents: number) =>
      grantAllows({ class: 'irreversible', sealed: 'spend.money', amountCents, spentTodayCents }, grant);
    expect(spend(1000, 0)).toBe(true);
    expect(spend(1000, 4000)).toBe(true); // exactly on the ceiling still counts
    expect(spend(1001, 4000)).toBe(false); // one cent over does not
    expect(spend(1, 5000)).toBe(false);
  });

  it('refuses an unsealed budget, an unknown price and nonsense numbers', () => {
    const noLimit: EveAuthorityGrant = { ladder: 5, capabilities: { 'spend.money': true }, updatedBy: 'user' };
    // Unsealed but unbounded is a blank cheque, so it is refused rather than treated as unlimited.
    expect(grantAllows({ class: 'irreversible', sealed: 'spend.money', amountCents: 1 }, noLimit)).toBe(false);

    const grant = withBudget(5000);
    // An action that cannot say what it costs cannot be paid for.
    expect(grantAllows({ class: 'irreversible', sealed: 'spend.money' }, grant)).toBe(false);
    for (const amountCents of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(grantAllows({ class: 'irreversible', sealed: 'spend.money', amountCents }, grant)).toBe(false);
    }
    expect(
      grantAllows({ class: 'irreversible', sealed: 'spend.money', amountCents: 1, spentTodayCents: -100 }, grant)
    ).toBe(false);
  });

  it('rejects a stored grant whose limit is not a usable amount', () => {
    for (const dailyCents of [0, -1, Number.NaN, 'viel'] as unknown[]) {
      expect(
        isEveAuthorityGrant({
          ladder: 3,
          capabilities: { 'spend.money': true },
          limits: { 'spend.money': { dailyCents } },
          updatedBy: 'user',
        })
      ).toBe(false);
    }
    expect(
      isEveAuthorityGrant({
        ladder: 3,
        capabilities: { 'spend.money': true },
        limits: { 'publish.outward': { dailyCents: 10 } },
        updatedBy: 'user',
      })
    ).toBe(false);
  });
});

describe('unknown is not harmless', () => {
  it('no rung admits an unclassified action', () => {
    for (const ladder of EVE_LADDER_RUNGS) {
      const grant: EveAuthorityGrant = {
        ladder,
        capabilities: Object.fromEntries(EVE_SEALED_CAPABILITIES.map((c) => [c, true])),
        updatedBy: 'user',
      };
      expect(grantAllows({ class: 'unclassified' }, grant)).toBe(false);
      expect(decideAuthority({ class: 'unclassified' }, grant).decision).toBe('ask');
    }
  });
});

describe('migration is input, never authority', () => {
  it('never unseals a capability, whatever the legacy value said', () => {
    for (const mode of ['yolo', 'bypassPermissions', 'full-access', 'dont_ask', 'auto', 'nonsense', '', null]) {
      const grant = migrateLegacyGrant(mode);
      expect(grant.updatedBy).toBe('migration');
      for (const sealed of EVE_SEALED_CAPABILITIES) {
        expect(grant.capabilities[sealed]).toBeUndefined();
        expect(grantAllows({ class: 'irreversible', sealed }, grant)).toBe(false);
      }
    }
  });

  it('does not promote a legacy yolo holder to the top rung', () => {
    // Those values predate the sealed set, so their holders never decided
    // anything about irreversible work. Rung 5 has to be chosen, not inherited.
    expect(ladderFromLegacyMode('yolo')).toBe(4);
    expect(ladderFromLegacyMode('bypassPermissions')).toBe(4);
    expect(grantAllows({ class: 'irreversible' }, migrateLegacyGrant('yolo'))).toBe(false);
  });

  it('maps the known modes and lands unknown ones on ask', () => {
    expect(ladderFromLegacyMode('plan')).toBe(0);
    expect(ladderFromLegacyMode('accept_edits')).toBe(2);
    expect(ladderFromLegacyMode('auto')).toBe(3);
    expect(ladderFromLegacyMode('etwas-neues')).toBe(1);
  });
});

describe('stored state that cannot be trusted fails closed', () => {
  it('reads a valid grant back unchanged', () => {
    const grant: EveAuthorityGrant = { ladder: 3, capabilities: { 'spend.money': true }, updatedBy: 'user' };
    expect(isEveAuthorityGrant(grant)).toBe(true);
    expect(readEveAuthorityGrant(grant)).toBe(grant);
  });

  it('rejects anything malformed rather than repairing it', () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      'ladder: 5',
      { ladder: 6, capabilities: {}, updatedBy: 'user' },
      { ladder: -1, capabilities: {}, updatedBy: 'user' },
      { ladder: 3, capabilities: {}, updatedBy: 'somebody-else' },
      { ladder: 3, capabilities: { 'spend.money': 'yes' }, updatedBy: 'user' },
      { ladder: 3, capabilities: { 'invent.capability': true }, updatedBy: 'user' },
      { ladder: 3, updatedBy: 'user' },
    ];
    for (const value of bad) {
      expect(isEveAuthorityGrant(value)).toBe(false);
      expect(readEveAuthorityGrant(value)).toBe(EVE_AUTHORITY_FAIL_CLOSED);
    }
    // And the fail-closed default is genuinely closed.
    expect(grantAllows({ class: 'workspace_edit' }, EVE_AUTHORITY_FAIL_CLOSED)).toBe(false);
    expect(grantAllows({ class: 'read' }, EVE_AUTHORITY_FAIL_CLOSED)).toBe(true);
  });
});

describe('rung 0 and rung 1 differ in whether EVE may offer at all', () => {
  it('admits the same classes but only rung 1 may propose an action', () => {
    const watch: EveAuthorityGrant = { ladder: 0, capabilities: {}, updatedBy: 'user' };
    const ask: EveAuthorityGrant = { ladder: 1, capabilities: {}, updatedBy: 'user' };
    expect(grantAllows({ class: 'read' }, watch)).toBe(grantAllows({ class: 'read' }, ask));
    expect(mayOfferToAct(0)).toBe(false);
    expect(mayOfferToAct(1)).toBe(true);
    for (const rung of EVE_LADDER_RUNGS.filter((r) => r >= 1)) {
      expect(mayOfferToAct(rung as EveLadderRung)).toBe(true);
    }
  });
});
