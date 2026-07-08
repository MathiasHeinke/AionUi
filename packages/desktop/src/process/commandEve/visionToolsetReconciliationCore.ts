/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE vision/toolset reconciliation (1.7.6 SG-07).
 *
 * Vision must be truth-gated before prompts, skills or UI can call it ready.
 * This core is pure: callers provide smoke, consent, disabled toolsets and
 * breaker state; the result says which routes/skills may be active.
 */

import type { CapabilityTruthSmoke } from './capabilityTruthCore';
import type { CapabilityState } from './runtimeGateCore';

export type VisionRouteKind = 'local' | 'cloud';

export type VisionRouteReasonCode =
  | 'vision.route.active'
  | 'vision.route.desired-not-active'
  | 'vision.route.toolset-disabled'
  | 'vision.route.local-smoke-required'
  | 'vision.route.local-smoke-failed'
  | 'vision.route.cloud-consent-required'
  | 'vision.route.provider-smoke-required'
  | 'vision.route.provider-smoke-failed'
  | 'vision.route.breaker-open';

export type VisionSkillReasonCode =
  | 'vision.skill.active'
  | 'vision.skill.desired-not-active'
  | 'vision.skill.toolset-disabled'
  | 'vision.skill.route-not-active';

export type VisionBreakerReasonCode = 'vision.failure-recorded' | 'vision.breaker-open';

export interface CapabilityBreaker {
  failures: number;
  maxFailures: number;
  disabledUntil?: string;
}

export interface CapabilityFailureReceipt {
  reasonCode: VisionBreakerReasonCode;
  emittedAt: string;
  failures: number;
  maxFailures: number;
  disabledUntil?: string;
}

export interface VisionRouteInput {
  id: string;
  kind: VisionRouteKind;
  desiredState?: CapabilityState;
  requiredToolsets: string[];
  disabledToolsets?: string[];
  localModelSmoke?: CapabilityTruthSmoke;
  providerSmoke?: CapabilityTruthSmoke;
  userConsent?: boolean;
  breaker?: CapabilityBreaker;
  now?: Date | string | number;
}

export interface VisionRouteTruth {
  id: string;
  kind: VisionRouteKind;
  state: CapabilityState;
  active: boolean;
  reasonCode: VisionRouteReasonCode;
  requiredToolsets: string[];
  blockedToolsets: string[];
  breaker?: CapabilityBreaker;
}

export interface VisionSkillDescriptor {
  id: string;
  label?: string;
  desiredState: CapabilityState;
  requiredToolsets: string[];
  requiredRouteIds?: string[];
}

export interface VisionSkillTruth {
  id: string;
  label?: string;
  state: CapabilityState;
  active: boolean;
  reasonCode: VisionSkillReasonCode;
  requiredToolsets: string[];
  blockedToolsets: string[];
  requiredRouteIds: string[];
  blockedRouteIds: string[];
}

export interface VisionToolsetReconciliationInput {
  routes: VisionRouteInput[];
  skills: VisionSkillDescriptor[];
  disabledToolsets?: string[];
  now?: Date | string | number;
}

export interface VisionToolsetReconciliation {
  routes: VisionRouteTruth[];
  skills: VisionSkillTruth[];
  activeRouteIds: string[];
  activeSkillIds: string[];
}

const ONE_HOUR_MS = 60 * 60 * 1000;

function dateFrom(value: Date | string | number | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function uniqueNonEmpty(values: readonly string[] | undefined): string[] {
  return Array.from(new Set((values || []).map((value) => value.trim()).filter(Boolean)));
}

function blockedToolsets(requiredToolsets: string[], disabledToolsets: string[]): string[] {
  const disabled = new Set(disabledToolsets);
  return requiredToolsets.filter((toolset) => disabled.has(toolset));
}

function smokePassed(smoke: CapabilityTruthSmoke | undefined): boolean {
  return smoke?.status === 'pass';
}

function smokeFailed(smoke: CapabilityTruthSmoke | undefined): boolean {
  return smoke?.status === 'fail';
}

function safeBreaker(breaker: CapabilityBreaker): CapabilityBreaker {
  const maxFailures =
    Number.isFinite(breaker.maxFailures) && breaker.maxFailures > 0 ? Math.floor(breaker.maxFailures) : 1;
  const failures = Number.isFinite(breaker.failures) && breaker.failures > 0 ? Math.floor(breaker.failures) : 0;
  return { ...breaker, failures, maxFailures };
}

export function recordCapabilityFailure(breaker: CapabilityBreaker, now = new Date()): CapabilityBreaker {
  const safe = safeBreaker(breaker);
  const failures = safe.failures + 1;
  if (failures >= safe.maxFailures) {
    return {
      ...safe,
      failures,
      disabledUntil: new Date(now.getTime() + ONE_HOUR_MS).toISOString(),
    };
  }
  return { ...safe, failures };
}

export function buildCapabilityFailureReceipt(
  breaker: CapabilityBreaker,
  emittedAt = new Date()
): CapabilityFailureReceipt {
  const safe = safeBreaker(breaker);
  const open = breakerOpen(safe, emittedAt);
  return {
    reasonCode: open ? 'vision.breaker-open' : 'vision.failure-recorded',
    emittedAt: emittedAt.toISOString(),
    failures: safe.failures,
    maxFailures: safe.maxFailures,
    ...(safe.disabledUntil ? { disabledUntil: safe.disabledUntil } : {}),
  };
}

export function breakerOpen(breaker: CapabilityBreaker | undefined, now: Date | string | number = new Date()): boolean {
  if (!breaker) return false;
  const safe = safeBreaker(breaker);
  const nowMs = dateFrom(now).getTime();
  if (safe.disabledUntil) {
    const disabledUntilMs = Date.parse(safe.disabledUntil);
    if (Number.isFinite(disabledUntilMs)) return disabledUntilMs > nowMs;
  }
  return safe.failures >= safe.maxFailures;
}

function routeTruth(
  input: VisionRouteInput,
  disabledToolsetsForRoute: string[],
  state: CapabilityState,
  reasonCode: VisionRouteReasonCode
): VisionRouteTruth {
  const requiredToolsets = uniqueNonEmpty(input.requiredToolsets);
  return {
    id: input.id.trim(),
    kind: input.kind,
    state,
    active: state === 'active',
    reasonCode,
    requiredToolsets,
    blockedToolsets: blockedToolsets(requiredToolsets, disabledToolsetsForRoute),
    ...(input.breaker ? { breaker: safeBreaker(input.breaker) } : {}),
  };
}

export function reconcileVisionRoute(input: VisionRouteInput): VisionRouteTruth {
  const desiredState = input.desiredState || 'active';
  const disabledToolsetsForRoute = uniqueNonEmpty(input.disabledToolsets);
  const requiredToolsets = uniqueNonEmpty(input.requiredToolsets);
  const blocked = blockedToolsets(requiredToolsets, disabledToolsetsForRoute);

  if (desiredState !== 'active') {
    return routeTruth(input, disabledToolsetsForRoute, desiredState, 'vision.route.desired-not-active');
  }

  if (blocked.length > 0) {
    return routeTruth(input, disabledToolsetsForRoute, 'deferred', 'vision.route.toolset-disabled');
  }

  if (breakerOpen(input.breaker, input.now)) {
    return routeTruth(input, disabledToolsetsForRoute, 'smoke_failed', 'vision.route.breaker-open');
  }

  if (input.kind === 'local') {
    if (smokeFailed(input.localModelSmoke)) {
      return routeTruth(input, disabledToolsetsForRoute, 'smoke_failed', 'vision.route.local-smoke-failed');
    }
    if (!smokePassed(input.localModelSmoke)) {
      return routeTruth(input, disabledToolsetsForRoute, 'deferred', 'vision.route.local-smoke-required');
    }
    return routeTruth(input, disabledToolsetsForRoute, 'active', 'vision.route.active');
  }

  if (input.userConsent !== true) {
    return routeTruth(input, disabledToolsetsForRoute, 'needs_consent', 'vision.route.cloud-consent-required');
  }

  if (smokeFailed(input.providerSmoke)) {
    return routeTruth(input, disabledToolsetsForRoute, 'smoke_failed', 'vision.route.provider-smoke-failed');
  }

  if (!smokePassed(input.providerSmoke)) {
    return routeTruth(input, disabledToolsetsForRoute, 'deferred', 'vision.route.provider-smoke-required');
  }

  return routeTruth(input, disabledToolsetsForRoute, 'active', 'vision.route.active');
}

export function reconcileVisionSkill(
  skill: VisionSkillDescriptor,
  routeTruths: readonly VisionRouteTruth[],
  disabledToolsets: readonly string[] = []
): VisionSkillTruth {
  const requiredToolsets = uniqueNonEmpty(skill.requiredToolsets);
  const requiredRouteIds = uniqueNonEmpty(skill.requiredRouteIds);
  const blocked = blockedToolsets(requiredToolsets, uniqueNonEmpty(disabledToolsets));
  const routesById = new Map(routeTruths.map((route) => [route.id, route]));
  const blockedRouteIds = requiredRouteIds.filter((routeId) => routesById.get(routeId)?.active !== true);

  if (skill.desiredState !== 'active') {
    return {
      id: skill.id.trim(),
      ...(skill.label ? { label: skill.label } : {}),
      state: skill.desiredState,
      active: false,
      reasonCode: 'vision.skill.desired-not-active',
      requiredToolsets,
      blockedToolsets: blocked,
      requiredRouteIds,
      blockedRouteIds,
    };
  }

  if (blocked.length > 0) {
    return {
      id: skill.id.trim(),
      ...(skill.label ? { label: skill.label } : {}),
      state: 'deferred',
      active: false,
      reasonCode: 'vision.skill.toolset-disabled',
      requiredToolsets,
      blockedToolsets: blocked,
      requiredRouteIds,
      blockedRouteIds,
    };
  }

  if (blockedRouteIds.length > 0) {
    return {
      id: skill.id.trim(),
      ...(skill.label ? { label: skill.label } : {}),
      state: 'deferred',
      active: false,
      reasonCode: 'vision.skill.route-not-active',
      requiredToolsets,
      blockedToolsets: blocked,
      requiredRouteIds,
      blockedRouteIds,
    };
  }

  return {
    id: skill.id.trim(),
    ...(skill.label ? { label: skill.label } : {}),
    state: 'active',
    active: true,
    reasonCode: 'vision.skill.active',
    requiredToolsets,
    blockedToolsets: [],
    requiredRouteIds,
    blockedRouteIds: [],
  };
}

export function reconcileVisionToolsets(input: VisionToolsetReconciliationInput): VisionToolsetReconciliation {
  const disabledToolsets = uniqueNonEmpty(input.disabledToolsets);
  const routes = input.routes.map((route) =>
    reconcileVisionRoute({
      ...route,
      disabledToolsets: uniqueNonEmpty([...(route.disabledToolsets || []), ...disabledToolsets]),
      now: route.now ?? input.now,
    })
  );
  const skills = input.skills.map((skill) => reconcileVisionSkill(skill, routes, disabledToolsets));
  return {
    routes,
    skills,
    activeRouteIds: routes.filter((route) => route.active).map((route) => route.id),
    activeSkillIds: skills.filter((skill) => skill.active).map((skill) => skill.id),
  };
}
