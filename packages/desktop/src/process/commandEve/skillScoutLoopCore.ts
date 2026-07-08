/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE skill scout + staged skill loop (1.7.7 SG-11).
 *
 * EVE may detect missing capabilities and propose skills, but proposal is not
 * installation. This pure core models candidate cards, guard scan results and
 * state transitions so production behavior cannot silently mutate from model
 * output.
 */

import type { RuntimeGateHumanGate } from './runtimeGateCore';

export type EveSkillState = 'candidate' | 'staged' | 'approved' | 'active' | 'rejected' | 'quarantined';
export type EveSkillSourceTrust = 'trusted_local' | 'trusted_remote' | 'untrusted_remote' | 'model_generated';
export type EveSkillRisk = 'low' | 'medium' | 'high';
export type EveSkillGuardStatus = 'pass' | 'review' | 'fail';
export type EveSkillRequester = 'model' | 'system' | 'human' | 'cao';
export type EveSkillProfileScope = 'current_profile' | 'cross_profile';
export type EveSkillLoopAction = 'stage' | 'approve' | 'activate' | 'reject' | 'quarantine';

export type EveSkillGuardReasonCode =
  | 'skill.guard.pass'
  | 'skill.guard.invalid'
  | 'skill.guard.secret-like-content'
  | 'skill.guard.high-risk-toolset'
  | 'skill.guard.untrusted-source'
  | 'skill.guard.model-generated-review';

export type EveSkillCandidateReasonCode =
  | 'skill.candidate.ready'
  | 'skill.candidate.review-required'
  | 'skill.candidate.untrusted-source'
  | 'skill.candidate.guard-failed';

export type EveSkillTransitionReasonCode =
  | 'skill.transition.pass'
  | 'skill.transition.invalid'
  | 'skill.transition.guard-failed'
  | 'skill.transition.untrusted-source'
  | 'skill.transition.human-required'
  | 'skill.transition.cao-required'
  | 'skill.transition.model-active-write-blocked'
  | 'skill.transition.cross-profile-blocked';

export type EveSkillLibraryCandidate = {
  id: string;
  name: string;
  description?: string;
  source: string;
  sourceTrust: EveSkillSourceTrust;
  capabilities: string[];
  requiredToolsets: string[];
  risk?: EveSkillRisk;
  markdown?: string;
};

export type EveSkillGuardResult = {
  status: EveSkillGuardStatus;
  reasonCode: EveSkillGuardReasonCode;
  humanGate: RuntimeGateHumanGate;
  findings: string[];
};

export type EveSkillCandidateCard = {
  id: string;
  name: string;
  description: string;
  source: string;
  sourceTrust: EveSkillSourceTrust;
  state: Extract<EveSkillState, 'candidate'>;
  missingCapability: string;
  requiredToolsets: string[];
  risk: EveSkillRisk;
  guard: EveSkillGuardResult;
  canStage: boolean;
  reasonCode: EveSkillCandidateReasonCode;
  humanGate: RuntimeGateHumanGate;
};

export type EveSkillTransitionDecision = {
  ok: boolean;
  from: EveSkillState;
  to: EveSkillState;
  reasonCode: EveSkillTransitionReasonCode;
  humanGate: RuntimeGateHumanGate;
};

const HIGH_RISK_TOOLSETS = new Set([
  'browser',
  'computer_use',
  'email',
  'phone',
  'payments',
  'card',
  'send_spend_publish',
]);

const SECRET_LIKE_PATTERN =
  /\b(?:api[_ -]?key|secret|password|bearer|token)\b\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}|\b(?:sk|ghp|gho|glpat|xox[baprs]|hf|or)-[A-Za-z0-9._-]{10,}\b/i;

function compact(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedList(values: readonly string[] | undefined): string[] {
  return Array.from(new Set((values || []).map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b)
  );
}

function riskRank(risk: EveSkillRisk): number {
  return risk === 'high' ? 3 : risk === 'medium' ? 2 : 1;
}

function guardFailure(
  reasonCode: EveSkillGuardReasonCode,
  humanGate: RuntimeGateHumanGate,
  findings: string[]
): EveSkillGuardResult {
  return { status: 'fail', reasonCode, humanGate, findings };
}

function guardReview(
  reasonCode: EveSkillGuardReasonCode,
  humanGate: RuntimeGateHumanGate,
  findings: string[]
): EveSkillGuardResult {
  return { status: 'review', reasonCode, humanGate, findings };
}

export function scanSkillCandidateGuard(candidate: EveSkillLibraryCandidate): EveSkillGuardResult {
  const id = compact(candidate.id);
  const name = compact(candidate.name);
  if (!id || !name) {
    return guardFailure('skill.guard.invalid', 'HG-2', ['missing-id-or-name']);
  }

  if (SECRET_LIKE_PATTERN.test(candidate.markdown || '')) {
    return guardFailure('skill.guard.secret-like-content', 'HG-3', ['secret-like-content']);
  }

  const riskyToolsets = normalizedList(candidate.requiredToolsets).filter((toolset) => HIGH_RISK_TOOLSETS.has(toolset));
  if (riskyToolsets.length > 0 || candidate.risk === 'high') {
    return guardReview('skill.guard.high-risk-toolset', 'HG-2.5', riskyToolsets);
  }

  if (candidate.sourceTrust === 'untrusted_remote') {
    return guardReview('skill.guard.untrusted-source', 'HG-2', ['untrusted-source']);
  }

  if (candidate.sourceTrust === 'model_generated') {
    return guardReview('skill.guard.model-generated-review', 'HG-2', ['model-generated']);
  }

  return { status: 'pass', reasonCode: 'skill.guard.pass', humanGate: 'HG-0', findings: [] };
}

function candidateReason(guard: EveSkillGuardResult, sourceTrust: EveSkillSourceTrust): EveSkillCandidateReasonCode {
  if (guard.status === 'fail') return 'skill.candidate.guard-failed';
  if (sourceTrust === 'untrusted_remote') return 'skill.candidate.untrusted-source';
  if (guard.status === 'review') return 'skill.candidate.review-required';
  return 'skill.candidate.ready';
}

function canStageCandidate(guard: EveSkillGuardResult, sourceTrust: EveSkillSourceTrust): boolean {
  return guard.status !== 'fail' && sourceTrust !== 'untrusted_remote';
}

export function buildSkillCandidateCards(input: {
  missingCapability: string;
  library: EveSkillLibraryCandidate[];
}): EveSkillCandidateCard[] {
  const missingCapability = compact(input.missingCapability);
  if (!missingCapability) return [];
  const cards: EveSkillCandidateCard[] = [];

  for (const candidate of input.library) {
    const capabilities = normalizedList(candidate.capabilities);
    if (!capabilities.includes(missingCapability)) continue;
    const guard = scanSkillCandidateGuard(candidate);
    const risk = candidate.risk || (guard.status === 'review' ? 'medium' : 'low');
    const reasonCode = candidateReason(guard, candidate.sourceTrust);
    cards.push({
      id: compact(candidate.id),
      name: compact(candidate.name) || compact(candidate.id),
      description: compact(candidate.description),
      source: compact(candidate.source),
      sourceTrust: candidate.sourceTrust,
      state: 'candidate',
      missingCapability,
      requiredToolsets: normalizedList(candidate.requiredToolsets),
      risk,
      guard,
      canStage: canStageCandidate(guard, candidate.sourceTrust),
      reasonCode,
      humanGate: guard.humanGate,
    });
  }

  cards.sort((a, b) => riskRank(b.risk) - riskRank(a.risk) || a.id.localeCompare(b.id));
  return cards;
}

function pass(from: EveSkillState, to: EveSkillState): EveSkillTransitionDecision {
  return { ok: true, from, to, reasonCode: 'skill.transition.pass', humanGate: 'HG-0' };
}

function block(
  from: EveSkillState,
  action: EveSkillLoopAction,
  reasonCode: EveSkillTransitionReasonCode,
  humanGate: RuntimeGateHumanGate
): EveSkillTransitionDecision {
  const fallback: Record<EveSkillLoopAction, EveSkillState> = {
    stage: 'candidate',
    approve: 'staged',
    activate: 'approved',
    reject: 'rejected',
    quarantine: 'quarantined',
  };
  return { ok: false, from, to: fallback[action], reasonCode, humanGate };
}

export function decideSkillLoopTransition(input: {
  currentState: EveSkillState;
  action: EveSkillLoopAction;
  guardStatus: EveSkillGuardStatus;
  sourceTrust: EveSkillSourceTrust;
  requestedBy: EveSkillRequester;
  profileScope: EveSkillProfileScope;
  humanApproved?: boolean;
  caoApproved?: boolean;
}): EveSkillTransitionDecision {
  if (input.action === 'reject') return pass(input.currentState, 'rejected');
  if (input.action === 'quarantine') return pass(input.currentState, 'quarantined');

  if (input.guardStatus === 'fail') {
    return block(input.currentState, input.action, 'skill.transition.guard-failed', 'HG-3');
  }

  if (input.action === 'stage') {
    if (input.currentState !== 'candidate') {
      return block(input.currentState, input.action, 'skill.transition.invalid', 'HG-1');
    }
    if (input.sourceTrust === 'untrusted_remote') {
      return block(input.currentState, input.action, 'skill.transition.untrusted-source', 'HG-2');
    }
    if (input.requestedBy !== 'human' && input.requestedBy !== 'cao' && input.humanApproved !== true) {
      return block(input.currentState, input.action, 'skill.transition.human-required', 'HG-2');
    }
    return pass(input.currentState, 'staged');
  }

  if (input.action === 'approve') {
    if (input.currentState !== 'staged') {
      return block(input.currentState, input.action, 'skill.transition.invalid', 'HG-1');
    }
    if (input.humanApproved !== true && input.caoApproved !== true) {
      return block(input.currentState, input.action, 'skill.transition.cao-required', 'HG-2');
    }
    return pass(input.currentState, 'approved');
  }

  if (input.action === 'activate') {
    if (input.currentState !== 'approved') {
      return block(input.currentState, input.action, 'skill.transition.invalid', 'HG-1');
    }
    if (input.requestedBy === 'model') {
      return block(input.currentState, input.action, 'skill.transition.model-active-write-blocked', 'HG-2');
    }
    if (input.profileScope === 'cross_profile') {
      return block(input.currentState, input.action, 'skill.transition.cross-profile-blocked', 'HG-3');
    }
    if (input.humanApproved !== true && input.caoApproved !== true) {
      return block(input.currentState, input.action, 'skill.transition.human-required', 'HG-2');
    }
    return pass(input.currentState, 'active');
  }

  return block(input.currentState, input.action, 'skill.transition.invalid', 'HG-1');
}
