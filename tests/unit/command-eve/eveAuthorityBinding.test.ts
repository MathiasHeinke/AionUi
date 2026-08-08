/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-1821 — the ladder and the seals BIND.
 *
 * Before this, `decideAuthority`/`grantAllows` had no production caller at all:
 * the panel offered three of six rungs, the five seals were not rendered, and
 * the approval path answered "ask" unconditionally. Everything above rung 1 was
 * a stored preference that changed nothing.
 *
 * These tests pin the connection itself, not the pure functions (those already
 * had their own suite). The distinction matters: a suite that only exercises
 * `grantAllows` stays green in a product that never calls it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EVE_AUTHORITY_FAIL_CLOSED,
  EVE_LADDER_RUNGS,
  EVE_SEALED_CAPABILITIES,
  type EveAuthorityGrant,
  type EveLadderRung,
} from '@/common/config/eveAuthorityCore';
import {
  decideCommandApproval,
  decideHermesToolApproval,
  renderEveAuthorityRuntime,
  sealImplicatedByCommand,
} from '@/common/config/eveAuthorityRuntimeCore';
import {
  ENFORCED_LADDER_RUNGS,
  isEnforcedLadderRung,
  ladderFromBackendMode,
  ladderToBackendMode,
  withDailyBudget,
  withSeal,
} from '@/common/config/eveAuthorityStoreCore';

const read = (relative: string): string => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const at = (ladder: EveLadderRung, over: Partial<EveAuthorityGrant> = {}): EveAuthorityGrant => ({
  ladder,
  capabilities: {},
  updatedBy: 'user',
  ...over,
});

const fullRelease = (): EveAuthorityGrant =>
  at(5, {
    capabilities: Object.fromEntries(EVE_SEALED_CAPABILITIES.map((capability) => [capability, true])),
    limits: { 'spend.money': { dailyCents: 5000 } },
  });

describe('A — the rung decides the class', () => {
  it('edits: ask below 2, inside the workspace at 2-3, anywhere from 4', () => {
    // The three policy strings are the wheel's own vocabulary
    // (whl:acp_adapter/edit_approval.py should_auto_approve_edit), which is what
    // makes this a binding and not an invention.
    expect(renderEveAuthorityRuntime(at(0)).edit_policy).toBe('ask');
    expect(renderEveAuthorityRuntime(at(1)).edit_policy).toBe('ask');
    expect(renderEveAuthorityRuntime(at(2)).edit_policy).toBe('workspace_session');
    expect(renderEveAuthorityRuntime(at(3)).edit_policy).toBe('workspace_session');
    expect(renderEveAuthorityRuntime(at(4)).edit_policy).toBe('session');
    expect(renderEveAuthorityRuntime(at(5)).edit_policy).toBe('session');
  });

  it('keeps browser/computer visible, lets navigation follow the ladder and operation-approves opaque acts', () => {
    for (const rung of EVE_LADDER_RUNGS) {
      const runtime = renderEveAuthorityRuntime(at(rung));
      expect(decideHermesToolApproval({ toolName: 'browser_snapshot' }, runtime)).toBe('allow');
      expect(decideHermesToolApproval({ toolName: 'computer_use', action: 'capture' }, runtime)).toBe('allow');
    }

    for (const rung of [0, 1, 2, 3] as const) {
      const runtime = renderEveAuthorityRuntime(at(rung));
      expect(decideHermesToolApproval({ toolName: 'browser_navigate' }, runtime)).toBe('ask');
      expect(decideHermesToolApproval({ toolName: 'browser_type' }, runtime)).toBe('ask');
      expect(decideHermesToolApproval({ toolName: 'computer_use', action: 'click' }, runtime)).toBe('ask');
    }

    for (const rung of [4, 5] as const) {
      const runtime = renderEveAuthorityRuntime(at(rung));
      expect(decideHermesToolApproval({ toolName: 'browser_navigate' }, runtime)).toBe('allow');
      expect(decideHermesToolApproval({ toolName: 'browser_scroll' }, runtime)).toBe('allow');
      expect(decideHermesToolApproval({ toolName: 'browser_type' }, runtime)).toBe('ask');
      expect(decideHermesToolApproval({ toolName: 'computer_use', action: 'click' }, runtime)).toBe('ask');
    }

    const released = renderEveAuthorityRuntime(fullRelease());
    expect(decideHermesToolApproval({ toolName: 'browser_type' }, released)).toBe('ask');
    expect(decideHermesToolApproval({ toolName: 'computer_use', action: 'click' }, released)).toBe('ask');
  });

  it('keeps ambiguous browser/computer calls and future upstream tools operation-approved', () => {
    const runtime = renderEveAuthorityRuntime(at(5));
    expect(decideHermesToolApproval({ toolName: 'browser_unknown' }, runtime)).toBe('ask');
    expect(decideHermesToolApproval({ toolName: 'computer_use' }, runtime)).toBe('ask');
    expect(decideHermesToolApproval({ toolName: 'some_future_tool' }, runtime)).toBe('ask');
    expect(decideHermesToolApproval({ toolName: 'some_future_tool' }, renderEveAuthorityRuntime(fullRelease()))).toBe(
      'ask'
    );
    expect(decideHermesToolApproval({ toolName: 'some_future_tool' }, renderEveAuthorityRuntime(at(4)))).toBe('ask');
  });

  it('lets harmless browser dialog dismissal follow rung 4 but keeps dialog acceptance opaque', () => {
    const runtime = renderEveAuthorityRuntime(at(4));
    expect(decideHermesToolApproval({ toolName: 'browser_dialog', action: 'dismiss' }, runtime)).toBe('allow');
    expect(decideHermesToolApproval({ toolName: 'browser_dialog', action: 'accept' }, runtime)).toBe('ask');
  });

  it('binds memory, skills, processes, schedules and product media to the user-selected authority', () => {
    expect(decideHermesToolApproval({ toolName: 'todo', action: 'read' }, renderEveAuthorityRuntime(at(0)))).toBe(
      'allow'
    );
    expect(decideHermesToolApproval({ toolName: 'todo', action: 'write' }, renderEveAuthorityRuntime(at(2)))).toBe(
      'ask'
    );
    expect(decideHermesToolApproval({ toolName: 'todo', action: 'write' }, renderEveAuthorityRuntime(at(3)))).toBe(
      'allow'
    );
    expect(decideHermesToolApproval({ toolName: 'process', action: 'poll' }, renderEveAuthorityRuntime(at(0)))).toBe(
      'allow'
    );
    expect(decideHermesToolApproval({ toolName: 'process', action: 'submit' }, renderEveAuthorityRuntime(at(3)))).toBe(
      'allow'
    );
    expect(decideHermesToolApproval({ toolName: 'memory', action: 'add' }, renderEveAuthorityRuntime(at(3)))).toBe(
      'ask'
    );
    expect(decideHermesToolApproval({ toolName: 'memory', action: 'add' }, renderEveAuthorityRuntime(at(4)))).toBe(
      'allow'
    );
    expect(decideHermesToolApproval({ toolName: 'memory', action: 'remove' }, renderEveAuthorityRuntime(at(4)))).toBe(
      'ask'
    );
    expect(decideHermesToolApproval({ toolName: 'memory', action: 'remove' }, renderEveAuthorityRuntime(at(5)))).toBe(
      'allow'
    );
    expect(decideHermesToolApproval({ toolName: 'cronjob', action: 'create' }, renderEveAuthorityRuntime(at(4)))).toBe(
      'allow'
    );
    expect(decideHermesToolApproval({ toolName: 'image_generate' }, renderEveAuthorityRuntime(at(0)))).toBe('allow');
    expect(decideHermesToolApproval({ toolName: 'video_generate' }, renderEveAuthorityRuntime(at(0)))).toBe('allow');
  });

  it('keeps outward and skill-deletion seals independent even on Full', () => {
    const closed = renderEveAuthorityRuntime(at(5));
    expect(decideHermesToolApproval({ toolName: 'discord', action: 'create_thread' }, closed)).toBe('ask');
    expect(decideHermesToolApproval({ toolName: 'skill_manage', action: 'delete' }, closed)).toBe('ask');

    const opened = renderEveAuthorityRuntime(
      at(5, {
        capabilities: { 'publish.outward': true, 'delete.outside': true },
      })
    );
    expect(decideHermesToolApproval({ toolName: 'discord', action: 'create_thread' }, opened)).toBe('allow');
    expect(decideHermesToolApproval({ toolName: 'skill_manage', action: 'delete' }, opened)).toBe('allow');
  });

  it('workspace commands: allowed from rung 3, asked below it', () => {
    for (const rung of [0, 1, 2] as const) {
      expect(
        decideCommandApproval({ command: 'npm test', insideWorkspace: true }, renderEveAuthorityRuntime(at(rung)))
      ).toBe('ask');
    }
    for (const rung of [3, 4, 5] as const) {
      expect(
        decideCommandApproval({ command: 'npm test', insideWorkspace: true }, renderEveAuthorityRuntime(at(rung)))
      ).toBe('allow');
    }
  });

  it('outside the working folder needs rung 4 — rung 3 is not enough', () => {
    expect(
      decideCommandApproval({ command: 'ls /etc', insideWorkspace: false }, renderEveAuthorityRuntime(at(3)))
    ).toBe('ask');
    expect(
      decideCommandApproval({ command: 'ls /etc', insideWorkspace: false }, renderEveAuthorityRuntime(at(4)))
    ).toBe('allow');
  });

  it('rung 0 is a hard off-switch: it closes the seals too', () => {
    // Not a detail. `grantAllows` short-circuits rung 0 to reads BEFORE it looks
    // at the seal, so a naive probe would report every open seal as usable on
    // the one rung that means "change nothing".
    const everySealOpen = at(0, {
      capabilities: Object.fromEntries(EVE_SEALED_CAPABILITIES.map((c) => [c, true])),
      limits: { 'spend.money': { dailyCents: 5000 } },
    });
    const runtime = renderEveAuthorityRuntime(everySealOpen);
    for (const capability of EVE_SEALED_CAPABILITIES) {
      expect(runtime.seals[capability], `${capability} survived the off-switch`).toBe(false);
    }
    expect(runtime.spend_daily_cents).toBe(0);
  });
});

describe('A — the five seals beat every rung, including 5', () => {
  const SEALED_COMMANDS: Array<[string, (typeof EVE_SEALED_CAPABILITIES)[number]]> = [
    ['git push origin main', 'publish.outward'],
    ['npm publish', 'publish.outward'],
    ['vercel deploy --prod', 'deploy.production'],
    ['kubectl apply -f k8s.yaml', 'deploy.production'],
    ['cat .env', 'credentials.read'],
    ['rm -rf /Users/someone/notes', 'delete.outside'],
    ['node scripts/stripe-charge.js', 'spend.money'],
  ];

  it.each(SEALED_COMMANDS)('%s is asked at rung 5 while its seal is shut', (command, capability) => {
    expect(sealImplicatedByCommand(command)).toBe(capability);
    // Rung 5 is the top of the ladder and it changes nothing here.
    expect(decideCommandApproval({ command, insideWorkspace: true }, renderEveAuthorityRuntime(at(5)))).toBe('ask');
  });

  it('an opened seal allows its own command — and only its own', () => {
    const withPublish = withSeal(at(1), 'publish.outward', true, '2026-08-07T00:00:00.000Z');
    const runtime = renderEveAuthorityRuntime(withPublish);
    // Rung 1 does not allow commands at all, but the seal is its own authority.
    expect(decideCommandApproval({ command: 'git push origin main', insideWorkspace: true }, runtime)).toBe('allow');
    // A different seal is untouched by it.
    expect(decideCommandApproval({ command: 'vercel deploy --prod', insideWorkspace: true }, runtime)).toBe('ask');
  });

  it('spend.money without a daily amount is REFUSED, never read as unlimited', () => {
    const openedButUnbudgeted = withSeal(at(5), 'spend.money', true, '2026-08-07T00:00:00.000Z');
    expect(openedButUnbudgeted.capabilities['spend.money']).toBe(true);
    const runtime = renderEveAuthorityRuntime(openedButUnbudgeted);
    expect(runtime.seals['spend.money'], 'an open seal with no ceiling became usable').toBe(false);
    expect(runtime.spend_daily_cents).toBe(0);
    expect(decideCommandApproval({ command: 'stripe charge', insideWorkspace: true }, runtime)).toBe('ask');

    const budgeted = withDailyBudget(openedButUnbudgeted, 5000);
    const live = renderEveAuthorityRuntime(budgeted);
    expect(live.seals['spend.money']).toBe(false);
    expect(live.spend_daily_cents).toBe(5000);
    expect(decideCommandApproval({ command: 'stripe charge', insideWorkspace: true }, live)).toBe('ask');
  });

  it('closing the money seal drops the budget with it', () => {
    const opened = withDailyBudget(withSeal(at(3), 'spend.money', true, '2026-08-07T00:00:00.000Z'), 5000);
    const closed = withSeal(opened, 'spend.money', false, '2026-08-07T00:00:00.000Z');
    expect(renderEveAuthorityRuntime(closed).spend_daily_cents).toBe(0);
    expect(closed.limits?.['spend.money']).toBeUndefined();
  });

  it('an unrecognised command is not treated as sealed — the rung decides it', () => {
    expect(sealImplicatedByCommand('echo hello')).toBeNull();
    expect(sealImplicatedByCommand('')).toBeNull();
  });
});

describe('A — the decision can only ever narrow', () => {
  it('there is no grant under which the fail-closed default allows anything', () => {
    const closed = renderEveAuthorityRuntime(EVE_AUTHORITY_FAIL_CLOSED);
    expect(closed.edit_policy).toBe('ask');
    expect(closed.workspace_command).toBe(false);
    expect(closed.outside_workspace_command).toBe(false);
    expect(closed.irreversible).toBe(false);
    for (const capability of EVE_SEALED_CAPABILITIES) expect(closed.seals[capability]).toBe(false);
    for (const command of ['npm test', 'git push', 'ls /etc', '']) {
      for (const insideWorkspace of [true, false]) {
        expect(decideCommandApproval({ command, insideWorkspace }, closed)).toBe('ask');
      }
    }
  });

  it('raising a rung never turns an allow into an ask (monotone in the safe direction)', () => {
    const commands = ['npm test', 'ls /etc', 'git push origin main', 'echo hi'];
    for (const command of commands) {
      for (const insideWorkspace of [true, false]) {
        let seenAllow = false;
        for (const rung of EVE_LADDER_RUNGS) {
          const verdict = decideCommandApproval({ command, insideWorkspace }, renderEveAuthorityRuntime(at(rung)));
          if (verdict === 'allow') seenAllow = true;
          else if (seenAllow) {
            throw new Error(`rung ${rung} revoked what a lower rung allowed for ${command}`);
          }
        }
      }
    }
  });
});

describe('B — all six rungs are offered, and each one means something', () => {
  it('ENFORCED_LADDER_RUNGS is the whole ladder', () => {
    expect([...ENFORCED_LADDER_RUNGS]).toEqual([...EVE_LADDER_RUNGS]);
    for (const rung of EVE_LADDER_RUNGS) expect(isEnforcedLadderRung(rung)).toBe(true);
  });

  it('no two rungs render the same behaviour by accident — the ladder actually steps', () => {
    // A rung that resolves to exactly the same runtime as its neighbour would be
    // a switch that stores a preference and changes nothing, which is the defect
    // this commit exists to remove. 0 and 1 are the ONE deliberate exception:
    // they differ in whether EVE may OFFER to act (`mayOfferToAct`), not in what
    // it may do unasked.
    const rendered = EVE_LADDER_RUNGS.map((rung) => JSON.stringify(renderEveAuthorityRuntime(at(rung))));
    const withoutLadderField = rendered.map((json) => json.replace(/"ladder":\d+,/, ''));
    const distinct = new Set(withoutLadderField);
    expect(distinct.size).toBe(EVE_LADDER_RUNGS.length - 1);
    expect(withoutLadderField[0]).toBe(withoutLadderField[1]);
  });

  it('the legacy mode mirror is still single-valued in the direction that matters', () => {
    // 0 and 1 both mirror `default`, so the inverse must be written down rather
    // than derived: deriving it would resolve `default` to rung 0 and silently
    // demote anyone whose in-chat pill said "ask" to the hard off-switch.
    expect(ladderToBackendMode(0)).toBe('default');
    expect(ladderToBackendMode(1)).toBe('default');
    expect(ladderFromBackendMode('default')).toBe(1);
    expect(ladderFromBackendMode('accept_edits')).toBe(2);
    expect(ladderFromBackendMode('dont_ask')).toBe(3);
    expect(ladderFromBackendMode('nonsense')).toBeNull();
  });

  it('a rung the wheel has no word for is still enforced — the mode is not the authority', () => {
    for (const rung of [4, 5] as const) {
      expect(ladderToBackendMode(rung)).toBeNull();
      expect(isEnforcedLadderRung(rung)).toBe(true);
      expect(renderEveAuthorityRuntime(at(rung)).outside_workspace_command).toBe(true);
    }
  });
});

describe('C — the panel renders the seals, and a new seat stays fail-closed', () => {
  const panel = read(
    'packages/desktop/src/renderer/components/settings/SettingsModal/contents/AuthorityModalContent.tsx'
  );

  it('every seal has a switch and the money seal has an amount', () => {
    expect(panel).toContain('EVE_SEALED_CAPABILITIES.map');
    expect(panel).toContain('data-testid={`seal-switch-${capability}`}');
    expect(panel).toContain("data-testid='seal-budget-money'");
    expect(panel).toContain('withSeal(');
    expect(panel).toContain('withDailyBudget(');
  });

  it('the panel no longer claims the seals are unenforced', () => {
    // The old comment stated the reason for hiding them: "NOTHING enforces them
    // yet: no production code calls grantAllows/decideAuthority". That sentence
    // must not survive a commit that makes it false.
    expect(panel).not.toContain('NOTHING enforces them yet');
    expect(panel).not.toContain('no production code calls');
  });

  it('an open money seal without an amount SAYS so instead of looking live', () => {
    expect(panel).toContain('grantNeedsAttention(grant)');
    expect(panel).toContain('budgetMissing');
  });

  it('the fail-closed default a new seat starts on: rung 1, no seals, no budget', () => {
    expect(EVE_AUTHORITY_FAIL_CLOSED.ladder).toBe(1);
    expect(EVE_AUTHORITY_FAIL_CLOSED.capabilities).toEqual({});
    expect(EVE_AUTHORITY_FAIL_CLOSED.limits).toBeUndefined();
    const runtime = renderEveAuthorityRuntime(EVE_AUTHORITY_FAIL_CLOSED);
    expect(runtime.edit_policy).toBe('ask');
    expect(Object.values(runtime.seals).every((open) => open === false)).toBe(true);
  });
});

describe('the shim is the ONE place the answer comes from', () => {
  const shim = read('packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts');
  const main = read('packages/desktop/src/index.ts');

  it('the approval route is authenticated like every other command-eve route', () => {
    expect(shim).toContain("requestPath === '/v1/command-eve/approval'");
    const route = shim.slice(shim.indexOf("requestPath === '/v1/command-eve/approval'"));
    expect(route.slice(0, 200)).toContain('requireShimAuth');
  });

  it('the structured Hermes tool route is authenticated too', () => {
    expect(shim).toContain("requestPath === '/v1/command-eve/tool-approval'");
    const route = shim.slice(shim.indexOf("requestPath === '/v1/command-eve/tool-approval'"));
    expect(route.slice(0, 220)).toContain('requireShimAuth');
  });

  it('an un-wired shim answers ask, never allow', () => {
    expect(shim).toContain('renderEveAuthorityRuntime(EVE_AUTHORITY_FAIL_CLOSED)');
  });

  it('main injects the LIVE resolver at every shim start site', () => {
    const starts = [...main.matchAll(/kanbanAcpRead: readKanbanAcpBoard,/g)].length;
    const injected = [...main.matchAll(/commandEveApproval: buildCommandEveShimApprovalResolver\(\),/g)].length;
    expect(starts).toBeGreaterThan(0);
    expect(injected, 'a shim start site would silently pin its seat to always-ask').toBe(starts);
  });

  it('the resolver reads the grant FRESH and fails closed', () => {
    const resolver = main.slice(
      main.indexOf('function buildCommandEveShimApprovalResolver'),
      main.indexOf('function buildCommandEveShimApprovalResolver') + 1200
    );
    expect(resolver).toContain("readCommandEveSettingsFromBackend(['commandEve.authority'])");
    expect(resolver).toContain('EVE_AUTHORITY_FAIL_CLOSED');
  });
});
