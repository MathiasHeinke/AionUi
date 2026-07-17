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
      executionRoute: 'claude_cli_acp',
      fallbackPolicy: 'none',
      lastSmoke: { status: 'pass', reportPath: '/tmp/smoke.json' },
    });
  });

  it.each(['claude', 'opus', 'fable'] as const)(
    'pins the %s worker to the Claude CLI/ACP seat route with no fallback',
    (workerId) => {
      const worker = registryWithActive([workerId]).workers.find((entry) => entry.id === workerId);

      expect(worker).toMatchObject({
        status: 'active',
        billingLane: 'seat',
        executionRoute: 'claude_cli_acp',
        fallbackPolicy: 'none',
      });
    }
  );

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
        executionRoute: 'claude_cli_acp',
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
        executionRoute: 'claude_cli_acp',
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'worker.needs-consent',
      humanGate: 'HG-2',
    });
  });

  it('allows active S0/S1 workers only through the final delegation gate', () => {
    expect(
      decideEveWorkerDelegation({
        registry: registryWithActive(['claude']),
        workerId: 'claude',
        sensitivity: 'S0-public',
        privacyMode: 'cloud_balanced',
        userConsent: true,
        executionRoute: 'claude_cli_acp',
      })
    ).toMatchObject({
      ok: true,
      reasonCode: 'worker.delegate-pass',
      humanGate: 'HG-0',
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
        executionRoute: 'eve_inference_openrouter',
      })
    ).toMatchObject({
      ok: false,
      billingLane: 'app_metered',
      reasonCode: 'worker.disabled-by-privacy',
      humanGate: 'HG-2',
    });
  });

  it('blocks restricted data and keeps Fable on the Claude Max seat at high effort', () => {
    expect(
      decideEveWorkerDelegation({
        registry: registryWithActive(['grok']),
        workerId: 'grok',
        sensitivity: 'S3-restricted',
        privacyMode: 'cloud_balanced',
        userConsent: true,
        executionRoute: 'eve_inference_openrouter',
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
        executionRoute: 'claude_cli_acp',
        requestedReasoningEffort: 'xhigh',
      })
    ).toMatchObject({
      ok: false,
      reasonCode: 'worker.fable-effort-cap',
      humanGate: 'HG-2.5',
    });

    expect(
      decideEveWorkerDelegation({
        registry: registryWithActive(['fable']),
        workerId: 'fable',
        sensitivity: 'S1-internal-low',
        privacyMode: 'cloud_balanced',
        userConsent: true,
        executionRoute: 'claude_cli_acp',
        requestedReasoningEffort: 'high',
      })
    ).toMatchObject({
      ok: true,
      billingLane: 'seat',
      reasonCode: 'worker.delegate-pass',
      humanGate: 'HG-0',
    });
  });

  it.each(['claude', 'opus', 'fable'] as const)(
    'refuses to dispatch the %s seat worker through EVE Inference/OpenRouter',
    (workerId) => {
      expect(
        decideEveWorkerDelegation({
          registry: registryWithActive([workerId]),
          workerId,
          sensitivity: 'S0-public',
          privacyMode: 'cloud_balanced',
          userConsent: true,
          executionRoute: 'eve_inference_openrouter',
        })
      ).toMatchObject({
        ok: false,
        billingLane: 'seat',
        executionRoute: 'claude_cli_acp',
        fallbackPolicy: 'none',
        reasonCode: 'worker.runtime-route-mismatch',
        humanGate: 'HG-2.5',
      });
    }
  );
});
