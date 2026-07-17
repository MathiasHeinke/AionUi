/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE worker registry + delegation policy (1.7.7 SG-10).
 *
 * This core is deliberately pure. It does not spawn Claude/Codex/Gemini or call
 * OpenRouter. It projects runtime facts into a visible worker truth table and
 * answers whether Hermes may delegate to a worker under privacy, consent, smoke
 * and data-class gates.
 */

import {
  decideRuntimeGate,
  type RuntimeGateAutonomyLevel,
  type RuntimeGateHumanGate,
  type RuntimeGatePrivacyMode,
  type SensitivityClass,
} from './runtimeGateCore';
import {
  CLAUDE_SEAT_BILLING_LANE,
  CLAUDE_SEAT_FALLBACK_POLICY,
  CLAUDE_SEAT_RUNTIME_ROUTE,
} from '../../common/config/eveWorkerAssignmentCore';

export type EveWorkerId = 'claude' | 'opus' | 'fable' | 'codex' | 'gemini' | 'deepseek' | 'glm' | 'grok';
export type EveWorkerStatus = 'active' | 'paused' | 'off' | 'deferred' | 'needs_auth' | 'smoke_failed';
export type EveWorkerBillingLane = 'seat' | 'app_metered' | 'byok' | 'local' | 'unknown';
export type EveWorkerExecutionRoute =
  | typeof CLAUDE_SEAT_RUNTIME_ROUTE
  | 'eve_inference_openrouter'
  | 'byok'
  | 'local'
  | 'unavailable';
export type EveWorkerFallbackPolicy = typeof CLAUDE_SEAT_FALLBACK_POLICY;
export type EveWorkerReleaseAuthority = 'none' | 'advisor_only' | 'controller_only';
export type EveWorkerReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type EveWorkerReasonCode =
  | 'worker.active'
  | 'worker.paused'
  | 'worker.off'
  | 'worker.deferred'
  | 'worker.unsupported'
  | 'worker.needs-auth'
  | 'worker.smoke-required'
  | 'worker.smoke-failed';

export type EveWorkerDelegationReasonCode =
  | 'worker.delegate-pass'
  | 'worker.unknown'
  | 'worker.not-active'
  | 'worker.disabled-by-privacy'
  | 'worker.data-class-blocked'
  | 'worker.needs-consent'
  | 'worker.human-required'
  | 'worker.runtime-route-mismatch'
  | 'worker.fable-effort-cap';

export type EveWorkerSmokeStatus = 'pass' | 'fail' | 'not_run';

export type EveWorkerSmoke = {
  status: EveWorkerSmokeStatus;
  reportPath?: string;
};

export interface EveWorkerTruth {
  id: EveWorkerId;
  status: EveWorkerStatus;
  suitedFor: string[];
  dataClassesAllowed: SensitivityClass[];
  billingLane: EveWorkerBillingLane;
  executionRoute: EveWorkerExecutionRoute;
  fallbackPolicy: EveWorkerFallbackPolicy;
  lastSmoke?: { status: 'pass' | 'fail'; reportPath?: string };
  releaseAuthority: EveWorkerReleaseAuthority;
  reasonCode: EveWorkerReasonCode;
  maxReasoningEffort?: EveWorkerReasoningEffort;
}

export type EveWorkerRuntimeSnapshot = {
  desiredStatus?: 'active' | 'paused' | 'off' | 'deferred';
  authReady?: boolean;
  smoke?: EveWorkerSmoke;
  supported?: boolean;
};

export type EveWorkerRegistryInput = {
  workers?: Partial<Record<EveWorkerId, EveWorkerRuntimeSnapshot>>;
  codexDelegationSupported?: boolean;
};

export type EveWorkerRegistry = {
  workers: EveWorkerTruth[];
  activeWorkerIds: EveWorkerId[];
  advisorWorkerIds: EveWorkerId[];
  delegableWorkerIds: EveWorkerId[];
};

export type EveWorkerDelegationDecision = {
  ok: boolean;
  workerId: EveWorkerId;
  workerStatus?: EveWorkerStatus;
  billingLane?: EveWorkerBillingLane;
  executionRoute?: EveWorkerExecutionRoute;
  fallbackPolicy?: EveWorkerFallbackPolicy;
  reasonCode: EveWorkerDelegationReasonCode;
  humanGate: RuntimeGateHumanGate;
};

type EveWorkerDescriptor = {
  id: EveWorkerId;
  suitedFor: string[];
  dataClassesAllowed: SensitivityClass[];
  billingLane: EveWorkerBillingLane;
  executionRoute: EveWorkerExecutionRoute;
  fallbackPolicy: EveWorkerFallbackPolicy;
  releaseAuthority: EveWorkerReleaseAuthority;
  requiresAuth: boolean;
  defaultSupported: boolean;
  maxReasoningEffort?: EveWorkerReasoningEffort;
};

const WORKER_ORDER: readonly EveWorkerId[] = ['claude', 'opus', 'fable', 'codex', 'gemini', 'deepseek', 'glm', 'grok'];

const WORKER_DESCRIPTORS: Record<EveWorkerId, EveWorkerDescriptor> = {
  claude: {
    id: 'claude',
    suitedFor: ['longform writing', 'code review', 'tool delegation', 'human-tone synthesis'],
    dataClassesAllowed: ['S0-public', 'S1-internal-low', 'S2-confidential'],
    billingLane: CLAUDE_SEAT_BILLING_LANE,
    executionRoute: CLAUDE_SEAT_RUNTIME_ROUTE,
    fallbackPolicy: CLAUDE_SEAT_FALLBACK_POLICY,
    releaseAuthority: 'none',
    requiresAuth: true,
    defaultSupported: true,
  },
  opus: {
    id: 'opus',
    suitedFor: ['Claude Max deep implementation', 'cross-file review', 'long-context synthesis'],
    dataClassesAllowed: ['S0-public', 'S1-internal-low', 'S2-confidential'],
    billingLane: CLAUDE_SEAT_BILLING_LANE,
    executionRoute: CLAUDE_SEAT_RUNTIME_ROUTE,
    fallbackPolicy: CLAUDE_SEAT_FALLBACK_POLICY,
    releaseAuthority: 'advisor_only',
    requiresAuth: true,
    defaultSupported: true,
    maxReasoningEffort: 'max',
  },
  fable: {
    id: 'fable',
    suitedFor: ['Claude Max product-feel challenge', 'high-level narrative review'],
    dataClassesAllowed: ['S0-public', 'S1-internal-low'],
    billingLane: CLAUDE_SEAT_BILLING_LANE,
    executionRoute: CLAUDE_SEAT_RUNTIME_ROUTE,
    fallbackPolicy: CLAUDE_SEAT_FALLBACK_POLICY,
    releaseAuthority: 'advisor_only',
    requiresAuth: true,
    defaultSupported: true,
    maxReasoningEffort: 'high',
  },
  codex: {
    id: 'codex',
    suitedFor: ['code implementation', 'controller review', 'diff reasoning'],
    dataClassesAllowed: ['S0-public', 'S1-internal-low', 'S2-confidential'],
    billingLane: 'seat',
    executionRoute: 'unavailable',
    fallbackPolicy: 'none',
    releaseAuthority: 'controller_only',
    requiresAuth: true,
    defaultSupported: false,
  },
  gemini: {
    id: 'gemini',
    suitedFor: ['long-context review', 'architecture drift', 'cross-file synthesis'],
    dataClassesAllowed: ['S0-public', 'S1-internal-low', 'S2-confidential'],
    billingLane: 'byok',
    executionRoute: 'byok',
    fallbackPolicy: 'none',
    releaseAuthority: 'advisor_only',
    requiresAuth: true,
    defaultSupported: true,
  },
  deepseek: {
    id: 'deepseek',
    suitedFor: ['bounded diff review', 'implementation challenge', 'cost-efficient advisor'],
    dataClassesAllowed: ['S0-public', 'S1-internal-low', 'S2-confidential'],
    billingLane: 'app_metered',
    executionRoute: 'eve_inference_openrouter',
    fallbackPolicy: 'none',
    releaseAuthority: 'advisor_only',
    requiresAuth: true,
    defaultSupported: true,
  },
  glm: {
    id: 'glm',
    suitedFor: ['long reasoning review', 'architecture challenge', 'spec-drift check'],
    dataClassesAllowed: ['S0-public', 'S1-internal-low', 'S2-confidential'],
    billingLane: 'app_metered',
    executionRoute: 'eve_inference_openrouter',
    fallbackPolicy: 'none',
    releaseAuthority: 'advisor_only',
    requiresAuth: true,
    defaultSupported: true,
  },
  grok: {
    id: 'grok',
    suitedFor: ['research challenge', 'multimodal provider lane', 'realtime-content exploration'],
    dataClassesAllowed: ['S0-public', 'S1-internal-low'],
    billingLane: 'app_metered',
    executionRoute: 'eve_inference_openrouter',
    fallbackPolicy: 'none',
    releaseAuthority: 'advisor_only',
    requiresAuth: true,
    defaultSupported: true,
  },
};

const EFFORT_RANK: Record<EveWorkerReasoningEffort, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

function visibleSmoke(smoke: EveWorkerSmoke | undefined): EveWorkerTruth['lastSmoke'] | undefined {
  if (!smoke || (smoke.status !== 'pass' && smoke.status !== 'fail')) return undefined;
  return {
    status: smoke.status,
    ...(smoke.reportPath ? { reportPath: smoke.reportPath } : {}),
  };
}

function workerSupported(
  descriptor: EveWorkerDescriptor,
  snapshot: EveWorkerRuntimeSnapshot | undefined,
  input: EveWorkerRegistryInput
): boolean {
  if (descriptor.id === 'codex') return input.codexDelegationSupported === true && snapshot?.supported !== false;
  return snapshot?.supported ?? descriptor.defaultSupported;
}

function decideWorkerTruth(
  descriptor: EveWorkerDescriptor,
  snapshot: EveWorkerRuntimeSnapshot | undefined,
  input: EveWorkerRegistryInput
): EveWorkerTruth {
  const desiredStatus = snapshot?.desiredStatus || 'active';
  let status: EveWorkerStatus = 'deferred';
  let reasonCode: EveWorkerReasonCode = 'worker.deferred';

  if (desiredStatus === 'off') {
    status = 'off';
    reasonCode = 'worker.off';
  } else if (desiredStatus === 'paused') {
    status = 'paused';
    reasonCode = 'worker.paused';
  } else if (desiredStatus === 'deferred' || !workerSupported(descriptor, snapshot, input)) {
    status = 'deferred';
    reasonCode = !workerSupported(descriptor, snapshot, input) ? 'worker.unsupported' : 'worker.deferred';
  } else if (descriptor.requiresAuth && snapshot?.authReady !== true) {
    status = 'needs_auth';
    reasonCode = 'worker.needs-auth';
  } else if (snapshot?.smoke?.status === 'fail') {
    status = 'smoke_failed';
    reasonCode = 'worker.smoke-failed';
  } else if (snapshot?.smoke?.status === 'pass') {
    status = 'active';
    reasonCode = 'worker.active';
  } else {
    status = 'deferred';
    reasonCode = 'worker.smoke-required';
  }

  return {
    id: descriptor.id,
    status,
    suitedFor: [...descriptor.suitedFor],
    dataClassesAllowed: [...descriptor.dataClassesAllowed],
    billingLane: descriptor.billingLane,
    executionRoute: descriptor.executionRoute,
    fallbackPolicy: descriptor.fallbackPolicy,
    releaseAuthority: descriptor.releaseAuthority,
    reasonCode,
    ...(descriptor.maxReasoningEffort ? { maxReasoningEffort: descriptor.maxReasoningEffort } : {}),
    ...(visibleSmoke(snapshot?.smoke) ? { lastSmoke: visibleSmoke(snapshot?.smoke) } : {}),
  };
}

export function buildEveWorkerRegistry(input: EveWorkerRegistryInput = {}): EveWorkerRegistry {
  const workers = WORKER_ORDER.map((id) => decideWorkerTruth(WORKER_DESCRIPTORS[id], input.workers?.[id], input));
  const activeWorkerIds = workers.filter((worker) => worker.status === 'active').map((worker) => worker.id);
  const advisorWorkerIds = workers
    .filter((worker) => worker.status === 'active' && worker.releaseAuthority === 'advisor_only')
    .map((worker) => worker.id);
  return {
    workers,
    activeWorkerIds,
    advisorWorkerIds,
    delegableWorkerIds: [...activeWorkerIds],
  };
}

function exceedsFableEffortCap(worker: EveWorkerTruth, requestedEffort: EveWorkerReasoningEffort | undefined): boolean {
  if (worker.id !== 'fable' || !requestedEffort || !worker.maxReasoningEffort) return false;
  return EFFORT_RANK[requestedEffort] > EFFORT_RANK[worker.maxReasoningEffort];
}

function cloudBilled(lane: EveWorkerBillingLane): boolean {
  return lane === 'seat' || lane === 'app_metered' || lane === 'byok' || lane === 'unknown';
}

export function decideEveWorkerDelegation(input: {
  registry: EveWorkerRegistry;
  workerId: EveWorkerId;
  sensitivity: SensitivityClass;
  privacyMode: RuntimeGatePrivacyMode;
  userConsent: boolean;
  executionRoute: EveWorkerExecutionRoute;
  autonomyLevel?: RuntimeGateAutonomyLevel;
  requestedReasoningEffort?: EveWorkerReasoningEffort;
}): EveWorkerDelegationDecision {
  const worker = input.registry.workers.find((item) => item.id === input.workerId);
  if (!worker) {
    return { ok: false, workerId: input.workerId, reasonCode: 'worker.unknown', humanGate: 'HG-2' };
  }

  if (worker.status !== 'active') {
    return {
      ok: false,
      workerId: worker.id,
      workerStatus: worker.status,
      billingLane: worker.billingLane,
      executionRoute: worker.executionRoute,
      fallbackPolicy: worker.fallbackPolicy,
      reasonCode: 'worker.not-active',
      humanGate: worker.status === 'needs_auth' ? 'HG-2' : 'HG-1',
    };
  }

  if (input.executionRoute !== worker.executionRoute) {
    return {
      ok: false,
      workerId: worker.id,
      workerStatus: worker.status,
      billingLane: worker.billingLane,
      executionRoute: worker.executionRoute,
      fallbackPolicy: worker.fallbackPolicy,
      reasonCode: 'worker.runtime-route-mismatch',
      humanGate: 'HG-2.5',
    };
  }

  if (input.privacyMode === 'local_only' && cloudBilled(worker.billingLane)) {
    return {
      ok: false,
      workerId: worker.id,
      workerStatus: worker.status,
      billingLane: worker.billingLane,
      executionRoute: worker.executionRoute,
      fallbackPolicy: worker.fallbackPolicy,
      reasonCode: 'worker.disabled-by-privacy',
      humanGate: 'HG-2',
    };
  }

  if (!worker.dataClassesAllowed.includes(input.sensitivity)) {
    return {
      ok: false,
      workerId: worker.id,
      workerStatus: worker.status,
      billingLane: worker.billingLane,
      executionRoute: worker.executionRoute,
      fallbackPolicy: worker.fallbackPolicy,
      reasonCode: 'worker.data-class-blocked',
      humanGate: input.sensitivity === 'S3-restricted' ? 'HG-3' : 'HG-2',
    };
  }

  if (exceedsFableEffortCap(worker, input.requestedReasoningEffort)) {
    return {
      ok: false,
      workerId: worker.id,
      workerStatus: worker.status,
      billingLane: worker.billingLane,
      executionRoute: worker.executionRoute,
      fallbackPolicy: worker.fallbackPolicy,
      reasonCode: 'worker.fable-effort-cap',
      humanGate: 'HG-2.5',
    };
  }

  const runtimeGate = decideRuntimeGate({
    capabilityId: `worker:${worker.id}`,
    requestedAction: 'delegate',
    sensitivity: input.sensitivity,
    autonomyLevel: input.autonomyLevel || 'L1',
    privacyMode: input.privacyMode,
    userConsent: input.userConsent,
    smokeState: 'active',
  });

  if (!runtimeGate.ok) {
    return {
      ok: false,
      workerId: worker.id,
      workerStatus: worker.status,
      billingLane: worker.billingLane,
      executionRoute: worker.executionRoute,
      fallbackPolicy: worker.fallbackPolicy,
      reasonCode: runtimeGate.reasonCode === 'gate.needs-consent' ? 'worker.needs-consent' : 'worker.human-required',
      humanGate: runtimeGate.humanGate,
    };
  }

  return {
    ok: true,
    workerId: worker.id,
    workerStatus: worker.status,
    billingLane: worker.billingLane,
    executionRoute: worker.executionRoute,
    fallbackPolicy: worker.fallbackPolicy,
    reasonCode: 'worker.delegate-pass',
    humanGate: 'HG-0',
  };
}
