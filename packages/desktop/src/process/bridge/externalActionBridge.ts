/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';

import { ipcBridge } from '@/common';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { EveExternalActionProposal } from '@/common/config/eveExternalActionExecutionCore';
import {
  decideAuthority,
  readEveAuthorityGrant,
  type EveAction,
  type EveAuthorityGrant,
} from '@/common/config/eveAuthorityCore';
import {
  failClosedEveExternalActionPolicyView,
  toEveExternalActionPolicyView,
  type EveExternalActionPolicyMutation,
  type EveExternalActionRiskClass,
} from '@/common/config/eveExternalActionPolicyCore';
import { seatScopedKey } from '@/common/config/seatConfigKeyCore';
import { getDataPath } from '@process/utils';
import {
  getExternalActionStore,
  resolveExternalActionBinding,
  NativeSecretMaterialResolver,
  ExternalActionExecutionService,
  signExternalActionPolicyContext,
  verifyExternalActionPolicyContext,
  type ExternalActionAdapter,
  type ExternalActionAdapterPayloadReadPort,
  type ExternalActionAuthorityResolution,
  type ExternalActionCompletionAttestationReadPort,
  type ExternalActionConversationContextReadPort,
  type ExternalActionReconciliationEvidenceReadPort,
  type ExternalActionReconciliationRequest,
  type ExternalActionSecretFieldSinkPort,
} from '@process/services/external-action';

const POLICY_VERSION = 'command-eve-external-action-policy/v0' as const;
const policyContextKey = crypto.randomBytes(32);
const mainAdapters: ExternalActionAdapter[] = [];
let mainAdapterPayloadReader: ExternalActionAdapterPayloadReadPort | null = null;
let mainCompletionAttestationReader: ExternalActionCompletionAttestationReadPort | null = null;
let mainConversationContextReader: ExternalActionConversationContextReadPort | null = null;
let mainReconciliationEvidenceReader: ExternalActionReconciliationEvidenceReadPort | null = null;
let mainSecretFieldSink: ExternalActionSecretFieldSinkPort | null = null;
let executionService: ExternalActionExecutionService | null = null;

/** Main-only adapter registration. Renderer/model IPC cannot call this. */
export function registerExternalActionAdapter(adapter: ExternalActionAdapter): void {
  if (executionService) throw new Error('EXTERNAL_ADAPTER_REGISTRY_LOCKED');
  if (mainAdapters.some((candidate) => candidate.id === adapter.id)) {
    throw new Error('EXTERNAL_ADAPTER_DUPLICATE');
  }
  mainAdapters.push(
    Object.freeze({
      ...adapter,
      operations: Object.freeze(adapter.operations.map((operation) => Object.freeze({ ...operation }))),
      supports: Object.freeze({ ...adapter.supports }),
    })
  );
}

/** Main-only immutable payload-store registration. No renderer/model bridge exists. */
export function registerExternalActionAdapterPayloadReadPort(reader: ExternalActionAdapterPayloadReadPort): void {
  if (executionService || mainAdapterPayloadReader)
    throw new Error('EXTERNAL_ADAPTER_PAYLOAD_READER_ALREADY_REGISTERED');
  mainAdapterPayloadReader = reader;
}

/** Main-only completion-attestation lookup. Renderer supplies an opaque ref only. */
export function registerExternalActionCompletionAttestationReadPort(
  reader: ExternalActionCompletionAttestationReadPort
): void {
  if (executionService || mainCompletionAttestationReader) {
    throw new Error('EXTERNAL_COMPLETION_ATTESTATION_READER_ALREADY_REGISTERED');
  }
  mainCompletionAttestationReader = reader;
}

/** Main-owned active conversation/session resolver. Renderer resume input never carries either value. */
export function registerExternalActionConversationContextReadPort(
  reader: ExternalActionConversationContextReadPort
): void {
  if (executionService || mainConversationContextReader) {
    throw new Error('EXTERNAL_CONVERSATION_CONTEXT_READER_ALREADY_REGISTERED');
  }
  mainConversationContextReader = reader;
}

/** Main-owned exact-origin secret sink. Adapters receive opaque delivery refs, never bytes. */
export function registerExternalActionSecretFieldSinkPort(sink: ExternalActionSecretFieldSinkPort): void {
  if (executionService || mainSecretFieldSink) throw new Error('EXTERNAL_SECRET_FIELD_SINK_ALREADY_REGISTERED');
  mainSecretFieldSink = sink;
}

/** Main-only reconciliation evidence lookup. There is deliberately no renderer provider. */
export function registerExternalActionReconciliationEvidenceReadPort(
  reader: ExternalActionReconciliationEvidenceReadPort
): void {
  if (executionService || mainReconciliationEvidenceReader) {
    throw new Error('EXTERNAL_RECONCILIATION_EVIDENCE_READER_ALREADY_REGISTERED');
  }
  mainReconciliationEvidenceReader = reader;
}

export async function reconcileExternalActionFromMain(
  request: ExternalActionReconciliationRequest
): ReturnType<ExternalActionExecutionService['reconcileFromMain']> {
  return currentService().reconcileFromMain(request);
}

function hashGrant(grant: EveAuthorityGrant): string {
  const stable = {
    ladder: grant.ladder,
    opaqueUiAutoRun: grant.opaqueUiAutoRun === true,
    opaqueUiAutoRunGrantedAt: grant.opaqueUiAutoRunGrantedAt ?? null,
    capabilities: Object.fromEntries(Object.entries(grant.capabilities).toSorted(([a], [b]) => a.localeCompare(b))),
    limits: grant.limits ?? null,
    updatedBy: grant.updatedBy,
  };
  return `grant:${crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 48)}`;
}

function authorityAction(proposal: EveExternalActionProposal, spentTodayMinor: number): EveAction {
  switch (proposal.action.kind) {
    case 'purchase':
    case 'recurring_payment':
      return {
        class: 'irreversible',
        sealed: 'spend.money',
        amountCents: proposal.action.amount.minorUnits,
        spentTodayCents: spentTodayMinor,
      };
    case 'communication_send':
      return { class: 'irreversible', sealed: 'publish.outward' };
    case 'artifact_modify':
      return { class: 'workspace_edit' };
    case 'account_create':
      return { class: 'irreversible' };
    case 'browser_submit':
    case 'desktop_action':
      return { class: 'unclassified', opaqueUiAction: true };
    case 'software_install':
    default:
      return { class: 'unclassified' };
  }
}

async function resolveExistingAuthority(input: {
  binding: { seedId: string };
  proposal: EveExternalActionProposal;
  spentTodayMinor: number;
  riskClass: EveExternalActionRiskClass;
}): Promise<ExternalActionAuthorityResolution> {
  const bag = await httpRequest<Record<string, unknown>>('GET', '/api/settings/client');
  const physicalKey = seatScopedKey('commandEve.authority', input.binding.seedId);
  // Security-sensitive by construction: a real Seed never falls back to the
  // unprefixed legacy/Founder grant. Missing or malformed resolves through
  // readEveAuthorityGrant to the confirmation-first fail-closed grant.
  const grant = readEveAuthorityGrant(bag?.[physicalKey]);
  const outcome = decideAuthority(authorityAction(input.proposal, input.spentTodayMinor), grant);
  return {
    decision: outcome.decision,
    authorityGrantId: hashGrant(grant),
    riskClass: input.riskClass,
  };
}

function currentService(): ExternalActionExecutionService {
  if (executionService) return executionService;
  const userDataPath = getDataPath();
  const store = getExternalActionStore(userDataPath);
  executionService = new ExternalActionExecutionService(store, {
    resolveBinding: () => resolveExternalActionBinding(store, userDataPath),
    resolveConversationContext: () =>
      mainConversationContextReader?.read() ?? { reasonCode: 'EXTERNAL_CONVERSATION_CONTEXT_UNAVAILABLE' },
    resolveAuthority: ({ binding, proposal, spentTodayMinor, riskClass }) =>
      resolveExistingAuthority({ binding, proposal, spentTodayMinor, riskClass }),
    secretResolver: new NativeSecretMaterialResolver(userDataPath),
    ...(mainSecretFieldSink ? { secretSink: mainSecretFieldSink } : {}),
    ...(mainAdapterPayloadReader ? { adapterPayloadReader: mainAdapterPayloadReader } : {}),
    ...(mainCompletionAttestationReader ? { completionAttestationReader: mainCompletionAttestationReader } : {}),
    ...(mainReconciliationEvidenceReader ? { reconciliationEvidenceReader: mainReconciliationEvidenceReader } : {}),
    adapters: mainAdapters,
  });
  return executionService;
}

function policyEnvelope(reasonCode?: string) {
  const userDataPath = getDataPath();
  const store = getExternalActionStore(userDataPath);
  const binding = resolveExternalActionBinding(store, userDataPath);
  if ('reasonCode' in binding) {
    return {
      version: POLICY_VERSION,
      ok: false,
      policy: failClosedEveExternalActionPolicyView(binding.reasonCode),
      reason_code: binding.reasonCode,
    };
  }
  const policy = store.getPolicy(binding.binding);
  return {
    version: POLICY_VERSION,
    ok: Boolean(policy) && !reasonCode,
    policy: policy
      ? toEveExternalActionPolicyView(policy)
      : failClosedEveExternalActionPolicyView(reasonCode ?? 'EXTERNAL_POLICY_NOT_CONFIGURED'),
    context_token: signExternalActionPolicyContext(
      policyContextKey,
      binding.binding,
      policy?.revision ?? 0,
      policy?.sessionEpoch ?? 0
    ),
    ...(reasonCode ? { reason_code: reasonCode } : {}),
  };
}

function hasExactKeys(input: unknown, keys: readonly string[]): input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  return keys.every((key) => Object.hasOwn(record, key)) && Object.keys(record).every((key) => keys.includes(key));
}

function resolvePolicyMutationContext(contextToken: unknown) {
  const userDataPath = getDataPath();
  const store = getExternalActionStore(userDataPath);
  const binding = resolveExternalActionBinding(store, userDataPath);
  if ('reasonCode' in binding) return { ok: false as const, reasonCode: binding.reasonCode };
  const policy = store.getPolicy(binding.binding);
  if (
    !verifyExternalActionPolicyContext(
      policyContextKey,
      contextToken,
      binding.binding,
      policy?.revision ?? 0,
      policy?.sessionEpoch ?? 0
    )
  ) {
    return { ok: false as const, reasonCode: 'EXTERNAL_POLICY_CONTEXT_STALE' };
  }
  return { ok: true as const, store, binding: binding.binding };
}

export function initExternalActionBridge(): void {
  ipcBridge.commandEve.externalActionPolicyGet.provider(async () => ({
    success: true,
    data: policyEnvelope(),
  }));

  ipcBridge.commandEve.externalActionPolicySet.provider(async (input) => {
    if (!hasExactKeys(input, ['context_token', 'mutation'])) {
      return { success: true, data: policyEnvelope('EXTERNAL_POLICY_REQUEST_INVALID') };
    }
    const context = resolvePolicyMutationContext(input.context_token);
    if (!context.ok) return { success: true, data: policyEnvelope(context.reasonCode) };
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const written = context.store.replacePolicy(
      context.binding,
      input.mutation as EveExternalActionPolicyMutation,
      timezone
    );
    return {
      success: true,
      data: !('reasonCode' in written) ? policyEnvelope() : policyEnvelope(written.reasonCode),
    };
  });

  ipcBridge.commandEve.externalActionPolicyKill.provider(async (input) => {
    if (!hasExactKeys(input, ['context_token', 'enabled']) || typeof input.enabled !== 'boolean') {
      return { success: true, data: policyEnvelope('EXTERNAL_POLICY_REQUEST_INVALID') };
    }
    const context = resolvePolicyMutationContext(input.context_token);
    if (!context.ok) return { success: true, data: policyEnvelope(context.reasonCode) };
    const written = context.store.setKillSwitch(context.binding, input.enabled);
    return {
      success: true,
      data: !('reasonCode' in written) ? policyEnvelope() : policyEnvelope(written.reasonCode),
    };
  });

  ipcBridge.commandEve.externalActionPolicyRevoke.provider(async (input) => {
    if (!hasExactKeys(input, ['context_token'])) {
      return { success: true, data: policyEnvelope('EXTERNAL_POLICY_REQUEST_INVALID') };
    }
    const context = resolvePolicyMutationContext(input.context_token);
    if (!context.ok) return { success: true, data: policyEnvelope(context.reasonCode) };
    const written = context.store.revokePolicy(context.binding);
    return {
      success: true,
      data: !('reasonCode' in written) ? policyEnvelope() : policyEnvelope(written.reasonCode),
    };
  });

  ipcBridge.commandEve.externalActionExecute.provider(async (proposal) => ({
    success: true,
    data: await currentService().execute(proposal),
  }));

  ipcBridge.commandEve.externalActionResume.provider(async (resume) => ({
    success: true,
    data: await currentService().resume(resume),
  }));
}

export function resetExternalActionBridgeForTests(): void {
  executionService = null;
  mainAdapterPayloadReader = null;
  mainCompletionAttestationReader = null;
  mainConversationContextReader = null;
  mainReconciliationEvidenceReader = null;
  mainSecretFieldSink = null;
  mainAdapters.splice(0, mainAdapters.length);
}
