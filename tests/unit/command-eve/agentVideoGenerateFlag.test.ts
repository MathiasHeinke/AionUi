/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-18205 — the generate flag, which is the WHOLE containment for this lane.
 *
 * The edit tools can afford a relaxed flag because a single-use, turn-bound
 * spend permit stands behind them. Generate has no such permit
 * (`handleCommandEveVideoGenerate` takes none and redeems none), so this
 * resolver is not one gate among several — it is the only thing on this side
 * between a model and a repeated debit. That is why every spelling gets its own
 * assertion instead of a representative sample: a flag that turns on by accident
 * is, here, a bill that arrives by accident.
 *
 * Two properties, and they are independent:
 *
 *   1. OPT-IN IS EXACT. Only `'1'` opens it. `'true'`, `'yes'`, `'on'` and every
 *      other truthy-looking spelling are OFF.
 *   2. OPT-IN IS NOT SUFFICIENT. An ineligible seat stays closed even at `'1'`.
 *      Advertising a paid capability on a seat that cannot pay is forbidden
 *      whatever the environment says.
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_VIDEO_GENERATE_DURATION_SECONDS,
  AGENT_VIDEO_GENERATE_TIER_ID,
  COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG as FLAG,
  isAgentVideoGenerateEnabled,
  resolveAgentVideoGenerateAdvertisement,
} from '@/process/commandEve/agentVideoGenerateFlag';
import { DEFAULT_VIDEO_TIER_ID } from '@/common/config/videoCostCore';

describe('the child-side read is exactly "1"', () => {
  it('opens on "1", including with surrounding whitespace', () => {
    expect(isAgentVideoGenerateEnabled({ [FLAG]: '1' })).toBe(true);
    expect(isAgentVideoGenerateEnabled({ [FLAG]: ' 1 ' })).toBe(true);
  });

  it('stays closed for every other spelling, and for absence', () => {
    for (const value of ['', '0', 'true', 'TRUE', 'yes', 'on', 'enabled', '11', '1.0', ' ']) {
      expect(isAgentVideoGenerateEnabled({ [FLAG]: value }), `"${value}" must not open the lane`).toBe(false);
    }
    expect(isAgentVideoGenerateEnabled({})).toBe(false);
  });
});

describe('the Main-side advertisement decision', () => {
  it('is DEFAULT-OFF: an eligible seat that did not opt in is closed', () => {
    expect(resolveAgentVideoGenerateAdvertisement({ env: {}, licenseWirePresent: true })).toBe(false);
  });

  it('opens only when BOTH the exact opt-in and eligibility are present', () => {
    expect(resolveAgentVideoGenerateAdvertisement({ env: { [FLAG]: '1' }, licenseWirePresent: true })).toBe(true);
  });

  it('refuses to let the env override eligibility', () => {
    // The important negative: a seat with no readable licence wire cannot buy
    // its way in with an env var.
    expect(resolveAgentVideoGenerateAdvertisement({ env: { [FLAG]: '1' }, licenseWirePresent: false })).toBe(false);
  });

  it('treats every non-"1" spelling as closed even on an eligible seat', () => {
    for (const value of ['0', 'true', 'yes', '']) {
      expect(
        resolveAgentVideoGenerateAdvertisement({ env: { [FLAG]: value }, licenseWirePresent: true }),
        `"${value}" must not advertise`
      ).toBe(false);
    }
  });
});

describe('the pinned request axes', () => {
  it('names a tier and a duration the model never chooses', () => {
    // Asserted against the SHARED constant, not a literal. A literal would keep
    // passing after someone moved the product default, leaving the agent lane
    // quietly on an old tier — which is the drift this pin exists to catch.
    expect(AGENT_VIDEO_GENERATE_TIER_ID).toBe(DEFAULT_VIDEO_TIER_ID);
    expect(AGENT_VIDEO_GENERATE_DURATION_SECONDS).toBe(5);
  });
});
