/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SG-1 Design B — the propose clause in the team directive is emitted ONLY when the
 * team_manage bearer is provisioned in env (operator seat). On a client seat the
 * bearer is never baked (ISO-6 non-provisioning), so EVE is not even told the
 * mechanism. This proves the directive half of B5.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { eveTeamDirective } from '@/process/commandEve/runtimeBootstrapCore';

const ROLES = [
  { agent_id: 'growth-lead', display_name: 'Growth Lead', title: 'Growth Lead', status: 'active', worker: null, outcome: 'Mehr Reichweite' },
] as unknown as Parameters<typeof eveTeamDirective>[0];

const KEY = 'COMMAND_EVE_TEAM_MANAGE_BEARER';
const original = process.env[KEY];
afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe('eveTeamDirective — team_manage propose clause gating (B5)', () => {
  it('EMITS the propose mechanism when the bearer is provisioned (operator seat)', () => {
    process.env[KEY] = 'boot-bearer-abc';
    const out = eveTeamDirective(ROLES);
    expect(out).toMatch(/PROPOSE a team status change/i);
    expect(out).toContain('/eve/team/propose');
    expect(out).toContain('$COMMAND_EVE_TEAM_MANAGE_BEARER');
    // Honesty in the directive too: nothing changes before the operator confirms.
    expect(out).toMatch(/NOTHING changes until they click/i);
  });

  it('OMITS the propose clause when the bearer is absent (client seat — ISO-6)', () => {
    delete process.env[KEY];
    const out = eveTeamDirective(ROLES);
    // The roster is still described…
    expect(out).toContain('Growth Lead');
    // …but EVE is never told she can propose or how.
    expect(out).not.toMatch(/PROPOSE a team status change/i);
    expect(out).not.toContain('/eve/team/propose');
  });
});
