import { describe, expect, it } from 'vitest';

import {
  EVE_AUTHORITY_FAIL_CLOSED,
  EVE_SEALED_CAPABILITIES,
  grantAllows,
  type EveAuthorityGrant,
} from '@/common/config/eveAuthorityCore';
import {
  COMMAND_EVE_LEGACY_BACKEND,
  HIGH_DAILY_BUDGET_CENTS,
  classifyDailyBudget,
  grantNeedsAttention,
  isUnconfirmedGrant,
  resolveStoredGrant,
  withDailyBudget,
  withLadder,
  withOpaqueUiAutoRun,
  backendModeForGrant,
  isEnforcedLadderRung,
  rememberedCommandsFromSettings,
  withRememberedCommand,
  withSeal,
  withoutRememberedCommand,
} from '@/common/config/eveAuthorityStoreCore';

const NOW = '2026-07-27T21:00:00.000Z';

describe('one record, resolved the same way everywhere', () => {
  it('prefers a valid stored grant over the legacy value', () => {
    const stored: EveAuthorityGrant = { ladder: 4, capabilities: {}, updatedBy: 'user' };
    const resolved = resolveStoredGrant(stored, { [COMMAND_EVE_LEGACY_BACKEND]: { preferredMode: 'plan' } });
    expect(resolved).toBe(stored);
  });

  it('migrates once from the legacy per-backend mode when nothing is stored', () => {
    const resolved = resolveStoredGrant(undefined, {
      [COMMAND_EVE_LEGACY_BACKEND]: { preferredMode: 'accept_edits' },
    });
    expect(resolved.ladder).toBe(2);
    expect(resolved.updatedBy).toBe('migration');
    expect(isUnconfirmedGrant(resolved)).toBe(true);
  });

  it('never opens a seal while migrating, whatever the legacy value claimed', () => {
    for (const preferredMode of ['yolo', 'bypassPermissions', 'full-access', 'auto']) {
      const resolved = resolveStoredGrant(undefined, { [COMMAND_EVE_LEGACY_BACKEND]: { preferredMode } });
      for (const sealed of EVE_SEALED_CAPABILITIES) {
        expect(resolved.capabilities[sealed]).toBeUndefined();
        expect(grantAllows({ class: 'irreversible', sealed, amountCents: 1 }, resolved)).toBe(false);
      }
      expect(resolved.opaqueUiAutoRun).toBeUndefined();
    }
  });

  it('falls closed on malformed stored state instead of repairing it', () => {
    for (const bad of [
      null,
      42,
      'ladder: 5',
      { ladder: 9, capabilities: {}, updatedBy: 'user' },
      { ladder: 4, capabilities: {}, opaqueUiAutoRun: true, updatedBy: 'user' },
    ]) {
      expect(resolveStoredGrant(bad, null)).toBe(EVE_AUTHORITY_FAIL_CLOSED);
    }
    expect(resolveStoredGrant(undefined, {})).toBe(EVE_AUTHORITY_FAIL_CLOSED);
    expect(resolveStoredGrant(undefined, { [COMMAND_EVE_LEGACY_BACKEND]: { preferredMode: '   ' } })).toBe(
      EVE_AUTHORITY_FAIL_CLOSED
    );
  });

  it('ignores another backend’s legacy mode', () => {
    // Other backends keep their own preference for their own agents. Only the
    // Command EVE lane seeds the shared grant.
    const resolved = resolveStoredGrant(undefined, { codex: { preferredMode: 'full-access' } });
    expect(resolved).toBe(EVE_AUTHORITY_FAIL_CLOSED);
  });
});

describe('moving the ladder never touches a seal', () => {
  it('keeps open seals and their dates when the rung changes', () => {
    const opened = withSeal({ ladder: 1, capabilities: {}, updatedBy: 'user' }, 'publish.outward', true, NOW);
    const moved = withLadder(opened, 5);
    expect(moved.ladder).toBe(5);
    expect(moved.capabilities['publish.outward']).toBe(true);
    expect(moved.grantedAt?.['publish.outward']).toBe(NOW);
  });

  it('keeps the separate opaque UI choice when the rung changes', () => {
    const enabled = withOpaqueUiAutoRun({ ladder: 4, capabilities: {}, updatedBy: 'user' }, true, NOW);
    const paused = withLadder(enabled, 1);
    expect(paused.opaqueUiAutoRun).toBe(true);
    expect(paused.opaqueUiAutoRunGrantedAt).toBe(NOW);
    expect(grantAllows({ class: 'unclassified', opaqueUiAction: true }, paused)).toBe(false);
    expect(grantAllows({ class: 'unclassified', opaqueUiAction: true }, withLadder(paused, 4))).toBe(true);
  });

  it('opens no seal when the rung goes to the top', () => {
    const top = withLadder({ ladder: 1, capabilities: {}, updatedBy: 'user' }, 5);
    for (const sealed of EVE_SEALED_CAPABILITIES) {
      expect(top.capabilities[sealed]).toBeUndefined();
    }
  });

  it('refuses a rung that is not a rung, leaving the grant untouched', () => {
    const grant: EveAuthorityGrant = { ladder: 2, capabilities: {}, updatedBy: 'user' };
    for (const bad of [6, -1, 2.5, '3', null, undefined]) {
      expect(withLadder(grant, bad)).toBe(grant);
    }
  });
});

describe('a seal records when it was given, and leaves no trace when revoked', () => {
  it('stamps the moment the human opened it', () => {
    const grant = withSeal({ ladder: 3, capabilities: {}, updatedBy: 'migration' }, 'deploy.production', true, NOW);
    expect(grant.capabilities['deploy.production']).toBe(true);
    expect(grant.grantedAt?.['deploy.production']).toBe(NOW);
    expect(grant.updatedBy).toBe('user');
  });

  it('drops the flag, the date and — for money — the budget on revoke', () => {
    let grant = withSeal({ ladder: 3, capabilities: {}, updatedBy: 'user' }, 'spend.money', true, NOW);
    grant = withDailyBudget(grant, 5000);
    expect(grant.limits?.['spend.money']?.dailyCents).toBe(5000);

    grant = withSeal(grant, 'spend.money', false, NOW);
    expect(grant.capabilities['spend.money']).toBeUndefined();
    expect(grant.grantedAt?.['spend.money']).toBeUndefined();
    // Re-opening must require naming an amount again — a revoked budget that
    // silently comes back would be a grant nobody re-gave.
    expect(grant.limits?.['spend.money']).toBeUndefined();
    const reopened = withSeal(grant, 'spend.money', true, NOW);
    expect(grantAllows({ class: 'irreversible', sealed: 'spend.money', amountCents: 1 }, reopened)).toBe(false);
  });

  it('revoking one seal does not disturb its neighbours', () => {
    let grant: EveAuthorityGrant = { ladder: 4, capabilities: {}, updatedBy: 'user' };
    grant = withSeal(grant, 'publish.outward', true, NOW);
    grant = withSeal(grant, 'credentials.read', true, NOW);
    grant = withSeal(grant, 'publish.outward', false, NOW);
    expect(grant.capabilities['publish.outward']).toBeUndefined();
    expect(grant.capabilities['credentials.read']).toBe(true);
  });
});

describe('opaque Browser/Desktop auto-run is explicit, reversible and fail-closed', () => {
  it('cannot be enabled below Selbstständig', () => {
    for (const ladder of [0, 1, 2, 3] as const) {
      const grant: EveAuthorityGrant = { ladder, capabilities: {}, updatedBy: 'user' };
      expect(withOpaqueUiAutoRun(grant, true, NOW)).toBe(grant);
    }
  });

  it('records its own consent moment and can be withdrawn immediately', () => {
    const base: EveAuthorityGrant = { ladder: 4, capabilities: {}, updatedBy: 'migration' };
    const enabled = withOpaqueUiAutoRun(base, true, NOW);
    expect(enabled.opaqueUiAutoRun).toBe(true);
    expect(enabled.opaqueUiAutoRunGrantedAt).toBe(NOW);
    expect(enabled.updatedBy).toBe('user');
    expect(grantAllows({ class: 'unclassified', opaqueUiAction: true }, enabled)).toBe(true);

    const withdrawn = withOpaqueUiAutoRun(enabled, false, NOW);
    expect(withdrawn.opaqueUiAutoRun).toBeUndefined();
    expect(withdrawn.opaqueUiAutoRunGrantedAt).toBeUndefined();
    expect(grantAllows({ class: 'unclassified', opaqueUiAction: true }, withdrawn)).toBe(false);
  });

  it('never opens a concrete effect seal', () => {
    const enabled = withOpaqueUiAutoRun({ ladder: 5, capabilities: {}, updatedBy: 'user' }, true, NOW);
    expect(enabled.capabilities).toEqual({});
    for (const sealed of EVE_SEALED_CAPABILITIES) {
      expect(grantAllows({ class: 'irreversible', sealed, amountCents: 1 }, enabled)).toBe(false);
    }
  });
});

describe('a budget nobody typed is a budget nobody agreed to', () => {
  it('classifies amounts the settings panel may store', () => {
    expect(classifyDailyBudget(5000)).toBe('ok');
    expect(classifyDailyBudget(1)).toBe('ok');
    expect(classifyDailyBudget(HIGH_DAILY_BUDGET_CENTS + 1)).toBe('confirm');
    for (const bad of [0, -1, 12.5, Number.NaN, Number.POSITIVE_INFINITY, '50', null, undefined]) {
      expect(classifyDailyBudget(bad)).toBe('invalid');
    }
  });

  it('leaves the grant untouched when the amount is rejected', () => {
    const grant: EveAuthorityGrant = { ladder: 3, capabilities: { 'spend.money': true }, updatedBy: 'user' };
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      expect(withDailyBudget(grant, bad)).toBe(grant);
    }
  });

  it('names the one incoherent shape so the panel can say it out loud', () => {
    const moneyNoBudget: EveAuthorityGrant = {
      ladder: 5,
      capabilities: { 'spend.money': true },
      updatedBy: 'user',
    };
    // Refused at decision time anyway — but silence here would read as a broken
    // feature: a switch that is on and an EVE that never spends.
    expect(grantAllows({ class: 'irreversible', sealed: 'spend.money', amountCents: 1 }, moneyNoBudget)).toBe(false);
    expect(grantNeedsAttention(moneyNoBudget)).toBe('money-without-budget');

    expect(grantNeedsAttention(withDailyBudget(moneyNoBudget, 5000))).toBeNull();
    expect(grantNeedsAttention({ ladder: 5, capabilities: {}, updatedBy: 'user' })).toBeNull();
  });
});

describe('"you may always do this" — our record, not Hermes button', () => {
  const base: EveAuthorityGrant = { ladder: 2, capabilities: {}, updatedBy: 'migration' };

  it('stores the literal command WITHOUT claiming the ladder was chosen', () => {
    const next = withRememberedCommand(base, 'git status', NOW);
    expect(next.rememberedCommands).toEqual([{ command: 'git status', grantedAt: NOW }]);
    // P2 (Kimi): this used to stamp `updatedBy: 'user'`. `updatedBy` records
    // whether a human picked the LADDER, and remembering one command is not that
    // decision — so a rung a migration invented was presented as confirmed and
    // the "not confirmed yet" banner went quiet on a state nobody chose.
    expect(next.updatedBy).toBe('migration');
    expect(withRememberedCommand({ ...base, updatedBy: 'user' }, 'git status', NOW).updatedBy).toBe('user');
  });

  it('withdrawing a command likewise says nothing about the ladder', () => {
    const withCommand = withRememberedCommand(base, 'git status', NOW);
    expect(withoutRememberedCommand(withCommand, 'git status').updatedBy).toBe('migration');
  });

  it('leaves the grant untouched when the card offered something unstorable', () => {
    // Nothing may land in the allowlist that the human did not see on the card,
    // and nothing may be stored that Hermes could never match.
    for (const bad of ['', '   ', 'ls && rm -rf build', 'podman *']) {
      expect(withRememberedCommand(base, bad, NOW)).toBe(base);
    }
    // A second grant of the same command is a no-op, not a duplicate row.
    const once = withRememberedCommand(base, 'git status', NOW);
    expect(withRememberedCommand(once, 'git status', NOW)).toBe(once);
  });

  it('withdraws one command and leaves the others standing', () => {
    let grant = withRememberedCommand(base, 'git status', NOW);
    grant = withRememberedCommand(grant, 'bun run test', NOW);
    const revoked = withoutRememberedCommand(grant, 'git status');
    expect(revoked.rememberedCommands).toEqual([{ command: 'bun run test', grantedAt: NOW }]);
    // Withdrawing something that was never granted changes nothing at all.
    expect(withoutRememberedCommand(revoked, 'never granted')).toBe(revoked);
  });

  it('keeps remembered commands when the ladder or a seal moves', () => {
    const grant = withRememberedCommand(base, 'git status', NOW);
    expect(withLadder(grant, 5).rememberedCommands).toEqual(grant.rememberedCommands);
    expect(withSeal(grant, 'publish.outward', true, NOW).rememberedCommands).toEqual(grant.rememberedCommands);
  });
});

describe('the grants reach the runtime from the store alone', () => {
  it('resolves what the seat remembered out of a raw settings bag', () => {
    // P1 (independent review, Grok): the emitter accepted the grants and the
    // provisioning test passed them BY HAND, so nothing caught that no production
    // caller ever read them. A test that injects the value cannot catch a caller
    // that never supplies one — so this one starts from the store, like the real
    // resolver does.
    const bag = {
      'commandEve.authority': {
        ladder: 3,
        capabilities: {},
        updatedBy: 'user',
        rememberedCommands: [{ command: 'git status', grantedAt: NOW }],
      },
    };
    expect(rememberedCommandsFromSettings(bag)).toEqual([{ command: 'git status', grantedAt: NOW }]);
  });

  it('fails closed on an unreadable or empty bag', () => {
    // Never "everything the user once allowed is still allowed" — an empty list
    // just means EVE asks again.
    for (const bad of [null, undefined, {}, { 'commandEve.authority': 'nonsense' }, { 'commandEve.authority': null }]) {
      expect(rememberedCommandsFromSettings(bad as Record<string, unknown>)).toEqual([]);
    }
  });

  it('drops a row that would never match, even straight from the store', () => {
    const bag = {
      'commandEve.authority': {
        ladder: 2,
        capabilities: {},
        updatedBy: 'user',
        rememberedCommands: [
          { command: 'ls && rm -rf /', grantedAt: NOW },
          { command: 'bun run test', grantedAt: NOW },
        ],
      },
    };
    expect(rememberedCommandsFromSettings(bag)).toEqual([{ command: 'bun run test', grantedAt: NOW }]);
  });
});

/**
 * CEVE-1821 — this block used to say "a rung only reaches the UI when something
 * enforces it", and it pinned the ACP mode map as that something. That was true
 * while the approval path answered "ask" unconditionally: three rungs had a
 * wheel mode, the other three had nowhere to go, and offering them would have
 * shipped switches that stored a preference and changed nothing.
 *
 * The enforcement moved. It is now the approval patch asking `decideAuthority`
 * through the loopback shim on every decision, and that reads the RUNG, not a
 * mode string. So the mode map demoted itself to a legacy mirror — and "has a
 * mode" stopped being the same question as "is enforced".
 */
describe('the ACP mode is a legacy mirror, no longer the thing that enforces', () => {
  it('mirrors the three rungs the wheel has a word for', () => {
    expect(backendModeForGrant({ ladder: 1, capabilities: {}, updatedBy: 'user' })).toBe('default');
    expect(backendModeForGrant({ ladder: 2, capabilities: {}, updatedBy: 'user' })).toBe('accept_edits');
    expect(backendModeForGrant({ ladder: 3, capabilities: {}, updatedBy: 'user' })).toBe('dont_ask');
    // Rung 0 mirrors `default` too — it is stricter than rung 1, and the wheel
    // has no stricter mode, so the mirror rounds DOWN in the safe direction
    // while the real enforcement keeps them apart.
    expect(backendModeForGrant({ ladder: 0, capabilities: {}, updatedBy: 'user' })).toBe('default');
  });

  it('the rungs the wheel cannot express are still enforced', () => {
    for (const ladder of [4, 5] as const) {
      expect(backendModeForGrant({ ladder, capabilities: {}, updatedBy: 'user' })).toBeNull();
      // The old assertion here was `isEnforcedLadderRung(ladder) === false`.
      // Keeping it would now pin the defect: a rung that binds at the approval
      // path but hides from the panel.
      expect(isEnforcedLadderRung(ladder)).toBe(true);
    }
  });

  it('every rung is offered, and none of them is inert', () => {
    for (const ladder of [0, 1, 2, 3, 4, 5] as const) {
      expect(isEnforcedLadderRung(ladder)).toBe(true);
    }
  });
});
