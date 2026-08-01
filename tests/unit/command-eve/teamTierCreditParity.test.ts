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
 * IT DOES NOT TEST THE PANEL, and never did. It has no DOM and imports no
 * component; a claim about what the settings panel SHOWS cannot be made here.
 * That half lives in teamTierCreditParity.dom.test.tsx, which renders the real
 * `DeinTeamPanel` and reddens when the panel stops asking the core.
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

  it('every tier a REAL role runs on is declared metered in the registry', () => {
    // Driven off the shipped roster, so a role added on a new tier is covered
    // without editing this test.
    //
    // THE TAUTOLOGY IS GONE. This block used to also assert
    //   expect(wireTierConsumesCredits(role.tier)).toBe(row.consumesCredits === true)
    // where `wireTierConsumesCredits` READS that very `row` (eveInferenceCore:147)
    // — both sides came from one place, so it was `x === x` and could not fail for
    // any registry content. What is left is the claim that can: every tier a real
    // role runs on is declared metered, and any rung the registry does not know is
    // assumed to cost.
    for (const role of EVE_TEAM_ROSTER) {
      const row = EVE_INFERENCE_TIERS.find((t) => t.tier === role.tier);
      if (row) {
        expect(row.consumesCredits, `the registry declares tier "${role.tier}" free`).toBe(true);
      }
      expect(wireTierConsumesCredits(role.tier), `${role.agent_id} is shown as a free worker`).toBe(true);
    }
  });

  it('an UNKNOWN tier is assumed to cost, never assumed free', () => {
    // The fail-closed direction. A rung nobody has priced must not be advertised
    // as a gift; that is how a metered turn gets sold as free.
    expect(wireTierConsumesCredits('a-tier-that-does-not-exist')).toBe(true);
    expect(wireTierConsumesCredits('')).toBe(true);
  });
});
