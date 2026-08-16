/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-18205-FLAG — what the ENV may and may not do, after the release moved to
 * a per-seat config value.
 *
 * The first slice made this env var the release itself. That was wrong in a way
 * worth writing down: an env var is a property of the PROCESS, so it could not
 * express "this client seat may spend and that one may not" — and this is a
 * switch that spends a client's credits. The release now lives in the per-seat
 * config (`agentVideoGenerateSeatResolver.test.ts` covers it); the env kept only
 * the job it was actually good at.
 *
 * So this file pins a ONE-WAY door, and both directions are load-bearing:
 *
 *   - `'0'` closes every seat immediately, with no seat context and no backend
 *     round trip. That is what an emergency off has to be.
 *   - NOTHING the env can say OPENS anything. `'1'` in particular is inert. If
 *     it were required, an operator who ticks the box in the UI would get
 *     silence — the silently-dead-control failure the store-split lineage exists
 *     to prevent — and a client seat could inherit a founder's process env.
 *
 * 1.823.0 adds one stronger fence: until a confirmed turn can mint a single-use
 * generate permit, even Main's `'1'` carrier is inert. That keeps the unsafe MCP
 * tool unadvertised while the explicit composer lane remains available.
 */

import { describe, expect, it, vi } from 'vitest';

const readLicenseWireMock = vi.fn();
vi.mock('@/common/config/licenseWireAtRest', () => ({
  readLicenseWire: (...args: unknown[]) => readLicenseWireMock(...args),
}));

const {
  AGENT_VIDEO_GENERATE_DURATION_SECONDS,
  AGENT_VIDEO_GENERATE_TIER_ID,
  COMMAND_EVE_AGENT_VIDEO_GENERATE_FLAG: FLAG,
  isAgentVideoGenerateEnabled,
  isAgentVideoGenerateKillSwitched,
  isAgentVideoGenerateLicenseEligible,
} = await import('@/process/commandEve/agentVideoGenerateFlag');
const { DEFAULT_VIDEO_TIER_ID } = await import('@/common/config/videoCostCore');
const { AGENT_VIDEO_GENERATE_TURN_AUTHORITY_READY } = await import('@/common/config/agentVideoGenerateReleaseCore');

describe('the child-side carrier is fenced until turn authority exists', () => {
  it('keeps even Main\'s exact "1" carrier inert in 1.823.0', () => {
    expect(AGENT_VIDEO_GENERATE_TURN_AUTHORITY_READY).toBe(false);
    expect(isAgentVideoGenerateEnabled({ [FLAG]: '1' })).toBe(false);
    expect(isAgentVideoGenerateEnabled({ [FLAG]: ' 1 ' })).toBe(false);
  });

  it('stays closed for every other spelling, and for absence', () => {
    for (const value of ['', '0', 'true', 'TRUE', 'yes', 'on', 'enabled', '11', '1.0', ' ']) {
      expect(isAgentVideoGenerateEnabled({ [FLAG]: value }), `"${value}" must not open the lane`).toBe(false);
    }
    expect(isAgentVideoGenerateEnabled({})).toBe(false);
  });
});

describe('the env is a kill-switch and nothing else', () => {
  it('trips on exactly "0", trimmed', () => {
    expect(isAgentVideoGenerateKillSwitched({ [FLAG]: '0' })).toBe(true);
    expect(isAgentVideoGenerateKillSwitched({ [FLAG]: ' 0 ' })).toBe(true);
  });

  it('does not trip on absence or on any other value', () => {
    expect(isAgentVideoGenerateKillSwitched({})).toBe(false);
    for (const value of ['', '1', 'true', 'false', 'off', 'no', '00', ' ']) {
      expect(isAgentVideoGenerateKillSwitched({ [FLAG]: value }), `"${value}" must not kill-switch`).toBe(false);
    }
  });

  it('has no spelling that GRANTS the release — the door is one-way', () => {
    // There is deliberately no `resolveAgentVideoGenerateAdvertisement` any more:
    // this module cannot answer "may this seat spend?" at all, because the answer
    // is per-seat and lives in the config store. All it can do is veto.
    const flagModule = Object.keys({
      isAgentVideoGenerateEnabled,
      isAgentVideoGenerateKillSwitched,
      isAgentVideoGenerateLicenseEligible,
    });
    expect(flagModule).not.toContain('resolveAgentVideoGenerateAdvertisement');
  });
});

describe('licence eligibility', () => {
  it('is true only for a present, readable, non-empty wire', () => {
    readLicenseWireMock.mockReturnValue({ ok: true, wire: 'CEVE.v2.payload.sig' });
    expect(isAgentVideoGenerateLicenseEligible('/tmp/seat')).toBe(true);
  });

  it('fails closed for every unreadable or empty shape', () => {
    for (const wire of [
      { ok: false },
      { ok: false, wire: 'CEVE.v2.payload.sig' },
      { ok: true },
      { ok: true, wire: '' },
      { ok: true, wire: 42 },
    ]) {
      readLicenseWireMock.mockReturnValue(wire);
      expect(isAgentVideoGenerateLicenseEligible('/tmp/seat'), `${JSON.stringify(wire)} must be ineligible`).toBe(
        false
      );
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
