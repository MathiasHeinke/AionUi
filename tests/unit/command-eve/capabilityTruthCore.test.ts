/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  activeCapabilityInstructions,
  buildCapabilityTruthSnapshot,
  capabilityById,
  resolveCapabilityState,
  shouldAdvertiseCapability,
  type CapabilityTruthDescriptor,
} from '@/process/commandEve/capabilityTruthCore';

const BASE_CAPABILITY: CapabilityTruthDescriptor = {
  id: 'claude-worker',
  label: 'Claude Code Worker',
  kind: 'worker',
  desiredState: 'active',
  suitedFor: ['copywriting', 'long-form edits'],
  sensitivityAllowed: ['S0-public', 'S1-internal-low'],
  privacyModesAllowed: ['cloud_balanced', 'privacy_first'],
  requiresHumanGate: 'HG-2',
  smoke: { status: 'pass', checkedAt: '2026-07-08T10:00:00.000Z' },
};

function capability(overrides: Partial<CapabilityTruthDescriptor>): CapabilityTruthDescriptor {
  return { ...BASE_CAPABILITY, ...overrides };
}

describe('Command EVE capability truth core', () => {
  it('resolves active only when desired active is smoke-proven and privacy-allowed', () => {
    expect(
      resolveCapabilityState(
        {
          desiredState: 'active',
          privacyModesAllowed: ['cloud_balanced'],
          smoke: { status: 'pass' },
        },
        'cloud_balanced'
      )
    ).toBe('active');
  });

  it('keeps Claude/Codex/Gemini-style active desires deferred until smoke passes', () => {
    expect(
      resolveCapabilityState(
        {
          desiredState: 'active',
          privacyModesAllowed: ['cloud_balanced'],
          smoke: { status: 'not_run' },
        },
        'cloud_balanced'
      )
    ).toBe('deferred');
  });

  it('maps failed smoke and disallowed privacy to explicit non-active states', () => {
    expect(
      resolveCapabilityState(
        {
          desiredState: 'active',
          privacyModesAllowed: ['cloud_balanced'],
          smoke: { status: 'fail' },
        },
        'cloud_balanced'
      )
    ).toBe('smoke_failed');
    expect(
      resolveCapabilityState(
        {
          desiredState: 'active',
          privacyModesAllowed: ['cloud_balanced'],
          smoke: { status: 'pass' },
        },
        'local_only'
      )
    ).toBe('disabled_by_privacy');
  });

  it('keeps disabled vision out of active instructions and advertisements', () => {
    const snapshot = buildCapabilityTruthSnapshot({
      generatedAt: '2026-07-08T10:01:00.000Z',
      privacyMode: 'local_only',
      capabilities: [
        capability({
          id: 'vision-cloud',
          label: 'Cloud Vision',
          kind: 'tool',
          desiredState: 'active',
          suitedFor: ['image understanding'],
          privacyModesAllowed: ['cloud_balanced', 'privacy_first'],
          smoke: { status: 'pass' },
        }),
        capability({
          id: 'local-memory',
          label: 'Local Memory',
          kind: 'memory',
          desiredState: 'active',
          suitedFor: ['recall client facts', 'session continuity'],
          privacyModesAllowed: ['cloud_balanced', 'privacy_first', 'local_only'],
          smoke: { status: 'pass' },
        }),
      ],
    });

    expect(capabilityById(snapshot, 'vision-cloud')?.state).toBe('disabled_by_privacy');
    expect(shouldAdvertiseCapability(snapshot, 'vision-cloud')).toBe(false);
    expect(activeCapabilityInstructions(snapshot)).not.toContain('Cloud Vision');
    expect(activeCapabilityInstructions(snapshot)).toContain('Local Memory');
  });

  it('derives prompt and UI checks from the same snapshot for worker capabilities', () => {
    const snapshot = buildCapabilityTruthSnapshot({
      generatedAt: '2026-07-08T10:02:00.000Z',
      privacyMode: 'cloud_balanced',
      capabilities: [
        capability({
          id: 'claude-worker',
          smoke: { status: 'pass' },
        }),
        capability({
          id: 'codex-worker',
          label: 'Codex Worker',
          smoke: { status: 'not_run' },
        }),
        capability({
          id: 'gemini-worker',
          label: 'Gemini Worker',
          smoke: { status: 'not_run' },
        }),
      ],
    });

    expect(shouldAdvertiseCapability(snapshot, 'claude-worker')).toBe(true);
    expect(activeCapabilityInstructions(snapshot)).toContain('Claude Code Worker');
    expect(capabilityById(snapshot, 'codex-worker')?.state).toBe('deferred');
    expect(shouldAdvertiseCapability(snapshot, 'codex-worker')).toBe(false);
    expect(capabilityById(snapshot, 'gemini-worker')?.state).toBe('deferred');
    expect(activeCapabilityInstructions(snapshot)).not.toContain('Gemini Worker');
  });

  it('normalizes suitedFor entries deterministically without changing receipt evidence', () => {
    const snapshot = buildCapabilityTruthSnapshot({
      generatedAt: '2026-07-08T10:03:00.000Z',
      privacyMode: 'cloud_balanced',
      capabilities: [
        capability({
          suitedFor: ['writing', ' writing ', '', 'review'],
          receipt: { provider: 'OpenRouter', model: 'claude-fable-5', route: 'cloud' },
        }),
      ],
    });

    expect(snapshot.capabilities[0].suitedFor).toEqual(['writing', 'review']);
    expect(snapshot.capabilities[0].receipt).toEqual({
      provider: 'OpenRouter',
      model: 'claude-fable-5',
      route: 'cloud',
    });
  });
});
