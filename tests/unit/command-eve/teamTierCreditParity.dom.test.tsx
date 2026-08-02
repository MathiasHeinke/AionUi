/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WHAT THE TEAM PANEL ACTUALLY TELLS THE USER A WORKER COSTS.
 *
 * WHY THIS FILE EXISTS. `teamTierCreditParity.test.ts` claims to pin "panel and
 * core agree". It could not: it never touched the panel, and its central
 * assertion was TAUTOLOGICAL —
 *
 *     expect(wireTierConsumesCredits(role.tier)).toBe(row.consumesCredits === true)
 *
 * where `wireTierConsumesCredits` reads that very `row`. Both sides of the
 * comparison came from one place, so it was `x === x`. Measured: replacing the
 * panel's `wireTierConsumesCredits(role.tier)` call with the old hand-typed table
 * `{ standard: false, high: false, max: true, maximum: true }` — which relabels
 * every Standard and High worker a FREE worker — left the whole suite green.
 * The only DOM test that names the panel mocks it away
 * (eveRuntimePublicGate.dom.test.tsx), so the panel had no reader at all.
 *
 * SO: THE PANEL HERE IS REAL. `DeinTeamPanel` is imported and rendered, never
 * mocked. What IS mocked is strictly its boundary — the config store, the seat
 * usage bridge, the IPC bridge and the spend meter — none of which has an opinion
 * about what a tier costs. The assertion reads the RENDERED text.
 *
 * NAMING: `.dom.test.tsx`. The vitest `node` project takes `tests/unit/**\/*.test.ts`
 * and never `.tsx`; the `dom` project takes ONLY `*.dom.test.ts(x)`.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const CREDIT_MARKER = 'verbraucht Credits';

// i18n: return the key path for tier/label lookups so the rendered text is
// deterministic, and the real credit-marker wording for the one label under test.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => {
      if (key === 'deinTeam.labels.consumesCredits') return CREDIT_MARKER;
      return options?.defaultValue ?? key;
    },
  }),
}));

// The boundary, and only the boundary.
vi.mock('@renderer/hooks/config/useConfig', () => ({
  useConfig: () => [{}, vi.fn()],
}));
vi.mock('@renderer/hooks/useSeatUsage', () => ({
  useSeatUsage: () => ({
    // The honest "no ledger proof yet" snapshot, i.e. the real shape — not null.
    agentUsage: {
      status: 'unavailable' as const,
      period: '2026-08',
      reason: 'no_ledger' as const,
      rows: [] as const,
      total_calls: null,
      as_of: null,
    },
  }),
}));
vi.mock('@/common', () => ({
  ipcBridge: { commandEve: { syncWorkerLauncherState: { invoke: vi.fn().mockResolvedValue(undefined) } } },
}));
vi.mock('@renderer/components/team/ProjectedSpendMeter', () => ({
  default: () => <div data-testid='projected-spend-meter' />,
}));

// THE REAL PANEL, and the real roster + real core behind it.
import DeinTeamPanel from '@renderer/components/team/DeinTeamPanel';
import { EVE_TEAM_ROSTER } from '@/common/config/eveTeamRoster';
import { eveTeamRoleConsumesCredits } from '@/common/config/eveTeamControlsCore';

/** The metered roster, and the zero-cost floor, split by the ONE derived answer. */
const METERED_ROLES = EVE_TEAM_ROSTER.filter((role) => eveTeamRoleConsumesCredits(role));
const ZERO_COST_ROLES = EVE_TEAM_ROSTER.filter((role) => !eveTeamRoleConsumesCredits(role));

afterEach(() => {
  vi.clearAllMocks();
});

describe('the team panel never presents a metered worker as free — nor a local one as billed', () => {
  it('EVERY METERED role card rendered by the REAL panel carries the credit marker', () => {
    render(<DeinTeamPanel />);

    // Drive off the shipped roster, so a role added on a new tier is covered
    // without editing this test.
    expect(METERED_ROLES.length).toBeGreaterThan(0);
    for (const role of METERED_ROLES) {
      const card = document.querySelector(`[data-agent-id="${role.agent_id}"]`);
      expect(card, `no card rendered for ${role.agent_id}`).not.toBeNull();
      expect(
        card?.textContent ?? '',
        `${role.agent_id} (tier "${role.tier}") is presented as a FREE worker — its turns are metered`
      ).toContain(CREDIT_MARKER);
    }
  });

  it('THE ZERO-COST FLOOR carries NO credit marker — its own copy says "ohne Credits"', () => {
    // THE CONTRADICTION THIS ROW ENDS. The loop above used to run over the WHOLE
    // roster, so the `house-keeper` card was required to say "verbraucht Credits"
    // while the very same card renders the outcome line "… kostenlos und lokal,
    // ohne Credits." One card, both claims, and a green suite over the pair. A
    // gate that requires a contradiction is not a gate on the truth.
    //
    // It is derived, not enumerated: whatever the roster declares `free`, the panel
    // must agree with. If that set becomes empty this reds too — a gate with
    // nothing left to guard must say so rather than pass quietly.
    render(<DeinTeamPanel />);
    expect(ZERO_COST_ROLES.length).toBeGreaterThan(0);
    for (const role of ZERO_COST_ROLES) {
      const card = document.querySelector(`[data-agent-id="${role.agent_id}"]`);
      expect(card, `no card rendered for ${role.agent_id}`).not.toBeNull();
      expect(
        card?.textContent ?? '',
        `${role.agent_id} is the zero-cost local floor and must not be marked as spending credits`
      ).not.toContain(CREDIT_MARKER);
    }
  });

  it('the marker count equals the METERED roster size — no card is silently skipped', () => {
    // Guards the loop above against a future card that renders no agent-id: a
    // card that cannot be found cannot be checked, and "not found" must not read
    // as "fine".
    render(<DeinTeamPanel />);
    const markers = screen.getAllByText((_content, element) => {
      if (element?.tagName !== 'SPAN' && element?.tagName !== 'DIV') return false;
      return element?.textContent?.trim().endsWith(CREDIT_MARKER) === true;
    });
    // Every metered card contributes at least its own Tag; nested elements may
    // match too, so assert the FLOOR is the metered roster size, not an exact count.
    expect(markers.length).toBeGreaterThanOrEqual(METERED_ROLES.length);
  });

  it('the tiers a real role runs on include the ones the old hand-typed table called free', () => {
    // The sabotage this file exists to catch relabelled `standard` and `high`. If
    // the roster ever stops using them, this test would keep passing while
    // guarding nothing — so pin that the risky tiers are actually in play.
    const tiers = new Set(EVE_TEAM_ROSTER.map((role) => role.tier));
    expect(tiers.has('standard'), 'no role on tier "standard" — this gate no longer covers it').toBe(true);
    expect(tiers.has('high'), 'no role on tier "high" — this gate no longer covers it').toBe(true);
  });
});
