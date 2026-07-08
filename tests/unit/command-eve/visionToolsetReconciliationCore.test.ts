/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  breakerOpen,
  buildCapabilityFailureReceipt,
  reconcileVisionRoute,
  reconcileVisionToolsets,
  recordCapabilityFailure,
} from '@/process/commandEve/visionToolsetReconciliationCore';

const NOW = new Date('2026-07-08T10:00:00.000Z');

describe('Command EVE vision/toolset reconciliation core', () => {
  it('activates local vision only after local model smoke passes', () => {
    expect(
      reconcileVisionRoute({
        id: 'vision-local',
        kind: 'local',
        requiredToolsets: ['vision'],
        localModelSmoke: { status: 'not_run' },
        now: NOW,
      })
    ).toMatchObject({
      state: 'deferred',
      active: false,
      reasonCode: 'vision.route.local-smoke-required',
    });

    expect(
      reconcileVisionRoute({
        id: 'vision-local',
        kind: 'local',
        requiredToolsets: ['vision'],
        localModelSmoke: { status: 'pass', checkedAt: NOW.toISOString() },
        now: NOW,
      })
    ).toMatchObject({
      state: 'active',
      active: true,
      reasonCode: 'vision.route.active',
    });
  });

  it('activates cloud vision only after consent and provider smoke pass', () => {
    expect(
      reconcileVisionRoute({
        id: 'vision-cloud',
        kind: 'cloud',
        requiredToolsets: ['vision'],
        userConsent: false,
        providerSmoke: { status: 'pass' },
        now: NOW,
      })
    ).toMatchObject({
      state: 'needs_consent',
      active: false,
      reasonCode: 'vision.route.cloud-consent-required',
    });

    expect(
      reconcileVisionRoute({
        id: 'vision-cloud',
        kind: 'cloud',
        requiredToolsets: ['vision'],
        userConsent: true,
        providerSmoke: { status: 'fail', reportPath: '/tmp/vision-smoke.json' },
        now: NOW,
      })
    ).toMatchObject({
      state: 'smoke_failed',
      active: false,
      reasonCode: 'vision.route.provider-smoke-failed',
    });

    expect(
      reconcileVisionRoute({
        id: 'vision-cloud',
        kind: 'cloud',
        requiredToolsets: ['vision'],
        userConsent: true,
        providerSmoke: { status: 'pass' },
        now: NOW,
      })
    ).toMatchObject({
      state: 'active',
      active: true,
      reasonCode: 'vision.route.active',
    });
  });

  it('keeps routes and active skills inactive when the vision toolset is disabled', () => {
    const reconciliation = reconcileVisionToolsets({
      disabledToolsets: ['vision'],
      now: NOW,
      routes: [
        {
          id: 'vision-local',
          kind: 'local',
          requiredToolsets: ['vision'],
          localModelSmoke: { status: 'pass' },
        },
      ],
      skills: [
        {
          id: 'local-vision-qa',
          label: 'Local Vision QA',
          desiredState: 'active',
          requiredToolsets: ['vision'],
          requiredRouteIds: ['vision-local'],
        },
      ],
    });

    expect(reconciliation.activeRouteIds).toEqual([]);
    expect(reconciliation.activeSkillIds).toEqual([]);
    expect(reconciliation.routes[0]).toMatchObject({
      state: 'deferred',
      reasonCode: 'vision.route.toolset-disabled',
      blockedToolsets: ['vision'],
    });
    expect(reconciliation.skills[0]).toMatchObject({
      state: 'deferred',
      active: false,
      reasonCode: 'vision.skill.toolset-disabled',
      blockedToolsets: ['vision'],
    });
  });

  it('blocks active skill claims when the required route is not active', () => {
    const reconciliation = reconcileVisionToolsets({
      now: NOW,
      routes: [
        {
          id: 'vision-cloud',
          kind: 'cloud',
          requiredToolsets: ['vision'],
          userConsent: true,
          providerSmoke: { status: 'not_run' },
        },
      ],
      skills: [
        {
          id: 'image-understanding',
          desiredState: 'active',
          requiredToolsets: ['vision'],
          requiredRouteIds: ['vision-cloud'],
        },
      ],
    });

    expect(reconciliation.routes[0]).toMatchObject({
      state: 'deferred',
      reasonCode: 'vision.route.provider-smoke-required',
    });
    expect(reconciliation.skills[0]).toMatchObject({
      state: 'deferred',
      active: false,
      reasonCode: 'vision.skill.route-not-active',
      blockedRouteIds: ['vision-cloud'],
    });
  });

  it('opens the breaker after N failures and emits a receipt', () => {
    const one = recordCapabilityFailure({ failures: 0, maxFailures: 2 }, NOW);
    expect(one).toEqual({ failures: 1, maxFailures: 2 });
    expect(breakerOpen(one, NOW)).toBe(false);

    const two = recordCapabilityFailure(one, NOW);
    expect(two.disabledUntil).toBe('2026-07-08T11:00:00.000Z');
    expect(breakerOpen(two, NOW)).toBe(true);
    expect(buildCapabilityFailureReceipt(two, NOW)).toEqual({
      reasonCode: 'vision.breaker-open',
      emittedAt: '2026-07-08T10:00:00.000Z',
      failures: 2,
      maxFailures: 2,
      disabledUntil: '2026-07-08T11:00:00.000Z',
    });
  });

  it('uses an open breaker to prevent false vision readiness', () => {
    expect(
      reconcileVisionRoute({
        id: 'vision-cloud',
        kind: 'cloud',
        requiredToolsets: ['vision'],
        userConsent: true,
        providerSmoke: { status: 'pass' },
        breaker: { failures: 3, maxFailures: 3, disabledUntil: '2026-07-08T10:30:00.000Z' },
        now: NOW,
      })
    ).toMatchObject({
      state: 'smoke_failed',
      active: false,
      reasonCode: 'vision.route.breaker-open',
    });
  });
});
