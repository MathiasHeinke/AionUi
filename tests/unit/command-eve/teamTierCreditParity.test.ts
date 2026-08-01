/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PARITY: what the team panel tells a user a role COSTS must be what the
 * inference core says that tier costs.
 *
 * THE DEFECT THIS PINS. `DeinTeamPanel` carried its own table —
 * `{ standard: false, high: false, max: true, maximum: true }` — and rendered the
 * credit marker from it. eveInferenceCore declared `consumesCredits: true` for
 * every one of those rungs. So the settings panel told the user that Standard and
 * High workers cost nothing while every turn they took was debited, and deleting
 * the `true` in the core reddened nothing in the panel: the two were joined only
 * by someone remembering to update both.
 *
 * The panel now calls `wireTierConsumesCredits`, so the copy cannot drift. This
 * file is the second half — it fails if the shared answer ever becomes "free" for
 * a tier a real role runs on, whichever side changes.
 *
 * NAMING: `.test.ts` — the vitest `node` project takes `tests/unit/**\/*.test.ts`
 * and excludes `*.dom.test.*`. No DOM is needed: both sides are pure data.
 */

import { describe, expect, it } from 'vitest';
import { EVE_INFERENCE_TIERS, wireTierConsumesCredits } from '@/common/config/eveInferenceCore';
import { EVE_TEAM_ROSTER, type EveTeamRoleTier } from '@/common/config/eveTeamRoster';

const ALL_TEAM_TIERS: EveTeamRoleTier[] = ['standard', 'high', 'max', 'maximum'];

describe('team tier ↔ inference core credit parity', () => {
  it('no team tier is presented as free — every worker turn is a metered cloud turn', () => {
    for (const tier of ALL_TEAM_TIERS) {
      expect(wireTierConsumesCredits(tier), `team tier "${tier}" must not be shown as free`).toBe(true);
    }
  });

  it('every tier a REAL role runs on agrees with the core row for that wire tier', () => {
    // Driven off the shipped roster, so a role added on a new tier is covered
    // without editing this test.
    for (const role of EVE_TEAM_ROSTER) {
      const row = EVE_INFERENCE_TIERS.find((t) => t.tier === role.tier);
      const shown = wireTierConsumesCredits(role.tier);
      if (row) {
        expect(shown, `${role.agent_id}: panel and core disagree on tier "${role.tier}"`).toBe(
          row.consumesCredits === true
        );
      }
      expect(shown, `${role.agent_id} is shown as a free worker`).toBe(true);
    }
  });

  it('an UNKNOWN tier is assumed to cost, never assumed free', () => {
    // The fail-closed direction. A rung nobody has priced must not be advertised
    // as a gift; that is how a metered turn gets sold as free.
    expect(wireTierConsumesCredits('a-tier-that-does-not-exist')).toBe(true);
    expect(wireTierConsumesCredits('')).toBe(true);
  });
});
