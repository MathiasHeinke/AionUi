/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  buildEveWorkerRegistry,
  decideEveWorkerDelegation,
  type EveWorkerId,
  type EveWorkerRuntimeSnapshot,
} from '@/process/commandEve/workerRegistryCore';

function activeSnapshot(): EveWorkerRuntimeSnapshot {
  return { authReady: true, smoke: { status: 'pass', reportPath: '/tmp/smoke.json' } };
}

function registryWithActive(ids: EveWorkerId[]) {
  const workers: Partial<Record<EveWorkerId, EveWorkerRuntimeSnapshot>> = {};
  for (const id of ids) workers[id] = activeSnapshot();
  return buildEveWorkerRegistry({
    workers,
    codexDelegationSupported: ids.includes('codex'),
  });
}

describe('Command EVE worker registry core', () => {
  it('keeps Claude non-active until auth and smoke are both ready', () => {
    const missingAuth = buildEveWorkerRegistry({
      workers: { claude: { smoke: { status: 'pass' } } },
    }).workers.find((worker) => worker.id === 'claude');

    expect(missingAuth).toMatchObject({
      status: 'needs_auth',
      reasonCode: 'worker.needs-auth',
    });

    const smokeFailed = buildEveWorkerRegistry({
      workers: { claude: { authReady: true, smoke: { status: 'fail', reportPath: '/tmp/claude-smoke.md' } } },
    }).workers.find((worker) => worker.id === 'claude');

    expect(smokeFailed).toMatchObject({
      status: 'smoke_failed',
      reasonCode: 'worker.smoke-failed',
      lastSmoke: { status: 'fail', reportPath: '/tmp/claude-smoke.md' },
    });

    const active = registryWithActive(['claude']).workers.find((worker) => worker.id === 'claude');

    expect(active).toMatchObject({
      status: 'active',
      reasonCode: 'worker.active',
      billingLane: 'seat',
      lastSmoke: { status: 'pass', reportPath: '/tmp/smoke.json' },
    });
  });

  it('keeps Codex deferred unless the delegation seam is explicitly supported', () => {
    const unsupported = buildEveWorkerRegistry({
      workers: { codex: activeSnapshot() },
      codexDelegationSupported: false,
    }).workers.find((worker) => worker.id === 'codex');

    expect(unsupported).toMatchObject({
      status: 'deferred',
      reasonCode: 'worker.unsupported',
      releaseAuthority: 'controller_only',
    });

    const supported = registryWithActive(['codex']).workers.find((worker) => worker.id === 'codex');

    expect(supported).toMatchObject({
      status: 'active',
      reasonCode: 'worker.active',
      releaseAuthority: 'controller_only',
    });
  });

  it('exposes Gemini and OpenRouter models only as smoke-proven advisor lanes', () => {
    const registry = registryWithActive(['gemini', 'deepseek', 'glm', 'grok']);

    expect(registry.activeWorkerIds).toEqual(['gemini', 'deepseek', 'glm', 'grok']);
    expect(registry.advisorWorkerIds).toEqual(['gemini', 'deepseek', 'glm', 'grok']);
    expect(registry.workers.find((worker) => worker.id === 'gemini')).toMatchObject({
      status: 'active',
      billingLane: 'byok',
      releaseAuthority: 'advisor_only',
    });
    expect(registry.workers.find((worker) => worker.id === 'deepseek')).toMatchObject({
      status: 'active',
      billingLane: 'app_metered',
      releaseAuthority: 'advisor_only',
    });
  });

  it('blocks delegation to non-active workers and requires user consent for active workers', () => {
    const registry = buildEveWorkerRegistry({
      workers: { claude: { authReady: true, smoke: { status: 'not_run' } } },
    });

    expect(
      decideEveWorkerDelegation({
        registry,
        workerId: 'claude',
        sensitivity: 'S1-internal-low',
        privacyMode: 'cloud_balanced',
        userConsent: true,
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'worker.not-active',
      humanGate: 'HG-1',
    });

    expect(
      decideEveWorkerDelegation({
        registry: registryWithActive(['claude']),
        workerId: 'claude',
        sensitivity: 'S1-internal-low',
        privacyMode: 'cloud_balanced',
        userConsent: false,
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'worker.needs-consent',
      humanGate: 'HG-2',
    });
  });

  it('keeps cloud-billed workers out of local-only privacy mode', () => {
    expect(
      decideEveWorkerDelegation({
        registry: registryWithActive(['deepseek']),
        workerId: 'deepseek',
        sensitivity: 'S0-public',
        privacyMode: 'local_only',
        userConsent: true,
      })
    ).toMatchObject({
      ok: false,
      billingLane: 'app_metered',
      reasonCode: 'worker.disabled-by-privacy',
      humanGate: 'HG-2',
    });
  });

  it('blocks restricted data and caps Fable at high effort', () => {
    expect(
      decideEveWorkerDelegation({
        registry: registryWithActive(['grok']),
        workerId: 'grok',
        sensitivity: 'S3-restricted',
        privacyMode: 'cloud_balanced',
        userConsent: true,
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'worker.data-class-blocked',
      humanGate: 'HG-3',
    });

    expect(
      decideEveWorkerDelegation({
        registry: registryWithActive(['fable']),
        workerId: 'fable',
        sensitivity: 'S1-internal-low',
        privacyMode: 'cloud_balanced',
        userConsent: true,
        requestedReasoningEffort: 'xhigh',
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'worker.fable-effort-cap',
      humanGate: 'HG-2.5',
    });
  });
});
