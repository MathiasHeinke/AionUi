/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE browser/computer-use policy + memory provenance (1.7.7 SG-12).
 *
 * This is the pure contract layer. It never controls Chrome, takes screenshots or
 * writes memory. It decides whether a local action is allowed and resolves where
 * a remembered fact came from so EVE can answer "where do you know this from?"
 */

import path from 'node:path';

import {
  decideRuntimeGate,
  type RuntimeGateHumanGate,
  type RuntimeGatePrivacyMode,
  type SensitivityClass,
} from './runtimeGateCore';

export type EveLocalActionKind =
  | 'browser.open'
  | 'browser.read'
  | 'browser.form_fill'
  | 'computer.screenshot'
  | 'computer.click'
  | 'download.write';

export type EveCredentialMode = 'none' | 'forbidden' | 'user_confirmed' | 'vault_scoped';

export type EveLocalActionReasonCode =
  | 'local-action.pass'
  | 'local-action.smoke-not-active'
  | 'local-action.consent-required'
  | 'local-action.host-blocked'
  | 'local-action.credential-blocked'
  | 'local-action.download-path-blocked'
  | 'local-action.screenshot-restricted'
  | 'local-action.runtime-gate-blocked';

export type EveLocalActionPolicyInput = {
  action: EveLocalActionKind;
  privacyMode: RuntimeGatePrivacyMode;
  sensitivity: SensitivityClass;
  userConsent: boolean;
  smokeActive: boolean;
  targetSurface?: 'browser' | 'desktop';
  allowedHosts?: string[];
  targetUrl?: string;
  credentialMode?: EveCredentialMode;
  touchesCredentialField?: boolean;
  downloadPath?: string;
  allowedDownloadDirs?: string[];
};

export type EveLocalActionPolicyDecision = {
  ok: boolean;
  action: EveLocalActionKind;
  reasonCode: EveLocalActionReasonCode;
  humanGate: RuntimeGateHumanGate;
  receipt: {
    host?: string;
    credentialMode: EveCredentialMode;
    downloadPath?: string;
    sensitivity: SensitivityClass;
  };
};

export type MemoryFactSource =
  | 'onboarding'
  | 'company_brain'
  | 'user_memory'
  | 'honcho'
  | 'connector'
  | 'skill_proposal'
  | 'chat'
  | 'session_digest';

export type MemoryFact = {
  key: string;
  value: string;
  source: MemoryFactSource;
  sourceRef?: string;
  observedAt: string;
  confidence?: number;
};

export type MemoryFactResolution = {
  fact?: MemoryFact;
  conflictCount: number;
  reasonCode: 'memory.fact-selected' | 'memory.fact-missing';
  provenance?: {
    source: MemoryFactSource;
    sourceRef?: string;
    observedAt: string;
    confidence: number;
  };
};

const SOURCE_PRECEDENCE: Record<MemoryFactSource, number> = {
  user_memory: 80,
  company_brain: 70,
  onboarding: 60,
  honcho: 50,
  connector: 40,
  skill_proposal: 30,
  session_digest: 20,
  chat: 10,
};

function hostFromUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    return url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function normalizeHost(rawHost: string): string {
  return rawHost.trim().toLowerCase();
}

function hostAllowed(host: string | undefined, allowedHosts: readonly string[] | undefined): boolean {
  if (!host) return false;
  const normalizedHost = normalizeHost(host);
  return (allowedHosts || []).some((entry) => {
    const allowed = normalizeHost(entry);
    return normalizedHost === allowed || normalizedHost.endsWith(`.${allowed}`);
  });
}

/**
 * Pure string containment only. The fs-owning caller must enforce realpath
 * containment before any actual write so symlinked directories cannot escape.
 */
function isUnderDir(candidate: string, dir: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedDir = path.resolve(dir);
  return resolvedCandidate === resolvedDir || resolvedCandidate.startsWith(`${resolvedDir}${path.sep}`);
}

function blocksCredentialUse(
  action: EveLocalActionKind,
  credentialMode: EveCredentialMode,
  touchesCredentialField: boolean
): boolean {
  if (action !== 'browser.form_fill' && !(action === 'computer.click' && touchesCredentialField)) return false;
  return credentialMode !== 'user_confirmed' && credentialMode !== 'vault_scoped';
}

function runtimeActionFor(action: EveLocalActionKind): 'browser' | 'computer_use' {
  return action.startsWith('browser.') || action === 'download.write' ? 'browser' : 'computer_use';
}

function requiresHostAllowlist(input: EveLocalActionPolicyInput): boolean {
  if (input.action.startsWith('browser.') || input.action === 'download.write') return true;
  return (
    (input.action === 'computer.click' || input.action === 'computer.screenshot') && input.targetSurface === 'browser'
  );
}

function decision(
  input: EveLocalActionPolicyInput,
  ok: boolean,
  reasonCode: EveLocalActionReasonCode,
  humanGate: RuntimeGateHumanGate
): EveLocalActionPolicyDecision {
  const host = hostFromUrl(input.targetUrl);
  return {
    ok,
    action: input.action,
    reasonCode,
    humanGate,
    receipt: {
      ...(host ? { host } : {}),
      credentialMode: input.credentialMode || 'none',
      ...(input.downloadPath ? { downloadPath: path.resolve(input.downloadPath) } : {}),
      sensitivity: input.sensitivity,
    },
  };
}

export function decideLocalActionPolicy(input: EveLocalActionPolicyInput): EveLocalActionPolicyDecision {
  if (input.smokeActive !== true) {
    return decision(input, false, 'local-action.smoke-not-active', 'HG-1');
  }

  if (input.action === 'computer.screenshot' && input.sensitivity === 'S3-restricted') {
    return decision(input, false, 'local-action.screenshot-restricted', 'HG-3');
  }

  const runtimeGate = decideRuntimeGate({
    capabilityId: `local-action:${input.action}`,
    requestedAction: runtimeActionFor(input.action),
    sensitivity: input.sensitivity,
    autonomyLevel: 'L1',
    privacyMode: input.privacyMode,
    userConsent: input.userConsent,
    smokeState: 'active',
  });

  if (!runtimeGate.ok) {
    const reasonCode =
      runtimeGate.reasonCode === 'gate.needs-consent'
        ? 'local-action.consent-required'
        : 'local-action.runtime-gate-blocked';
    return decision(input, false, reasonCode, runtimeGate.humanGate);
  }

  if (requiresHostAllowlist(input) && !hostAllowed(hostFromUrl(input.targetUrl), input.allowedHosts)) {
    return decision(input, false, 'local-action.host-blocked', 'HG-2');
  }

  if (blocksCredentialUse(input.action, input.credentialMode || 'none', input.touchesCredentialField === true)) {
    return decision(input, false, 'local-action.credential-blocked', 'HG-3');
  }

  if (input.action === 'download.write') {
    const candidate = input.downloadPath ? path.resolve(input.downloadPath) : '';
    const allowed = (input.allowedDownloadDirs || []).some((dir) => candidate && isUnderDir(candidate, dir));
    if (!candidate || !allowed) {
      return decision(input, false, 'local-action.download-path-blocked', 'HG-2');
    }
  }

  return decision(input, true, 'local-action.pass', 'HG-0');
}

function confidenceOf(fact: MemoryFact): number {
  const value = typeof fact.confidence === 'number' && Number.isFinite(fact.confidence) ? fact.confidence : 0.5;
  return Math.max(0, Math.min(1, value));
}

function observedMs(fact: MemoryFact): number {
  const value = Date.parse(fact.observedAt);
  return Number.isFinite(value) ? value : 0;
}

function factScore(fact: MemoryFact): number {
  return SOURCE_PRECEDENCE[fact.source] * 1_000_000 + confidenceOf(fact) * 10_000 + observedMs(fact) / 1_000_000_000;
}

export function resolveMemoryFact(facts: readonly MemoryFact[], key: string): MemoryFactResolution {
  const targetKey = key.trim();
  const matching = facts.filter((fact) => fact.key.trim() === targetKey && fact.value.trim().length > 0);
  if (matching.length === 0) {
    return { conflictCount: 0, reasonCode: 'memory.fact-missing' };
  }
  const sorted = matching.toSorted((a, b) => factScore(b) - factScore(a) || a.source.localeCompare(b.source));
  const fact = sorted[0];
  return {
    fact,
    conflictCount: Math.max(0, matching.length - 1),
    reasonCode: 'memory.fact-selected',
    provenance: {
      source: fact.source,
      ...(fact.sourceRef ? { sourceRef: fact.sourceRef } : {}),
      observedAt: fact.observedAt,
      confidence: confidenceOf(fact),
    },
  };
}

export function explainMemoryProvenance(resolution: MemoryFactResolution): string {
  if (!resolution.fact || !resolution.provenance) return 'No memory source is available for this fact.';
  const ref = resolution.provenance.sourceRef ? ` (${resolution.provenance.sourceRef})` : '';
  return `${resolution.fact.key} comes from ${resolution.provenance.source}${ref}, observed at ${resolution.provenance.observedAt}.`;
}
