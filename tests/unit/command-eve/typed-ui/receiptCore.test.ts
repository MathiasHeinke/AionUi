/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  bindTypedUIEnvelopeToArtifact,
  TYPED_UI_ACTION_AUTHORIZATION_VERSION,
  TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
  type TypedUIActionAuthorizeRequest,
  type TypedUIActionReceipt,
} from '@/common/typedUI';
import {
  authorizeTypedUIAction,
  finalizeTypedUIAction,
  validateTypedUIActionReceiptRequest,
} from '@/process/commandEve/typedUIActionReceiptCore';
import {
  appendMainOwnedTypedUIProviderCompletionReceipt,
  appendTrustedTypedUIGenerationReceipt,
  appendTypedUIProvenanceAttestation,
  hashTypedUIEnvelope,
  TYPED_UI_GENERATION_RECEIPT_VERSION,
  TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION,
} from '@/process/commandEve/typedUIProvenanceAttestationCore';
import {
  createTypedUIActionHandlers,
  TYPED_UI_INTERNAL_ACTION_ID,
  type TypedUIActionHost,
} from '@/renderer/pages/conversation/Messages/components/TypedGenerativeUI';
import { createStateStore } from '@json-render/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TYPED_UI_TEST_RECEIPT_CONTEXT, typedUIFixture } from './fixtures';

const temporaryDirectories: string[] = [];
const ACTIVE_SEAT_ID = 'seat-receipt';
const SEAT_CONTEXT_REVISION = 17;

function createEvidence(directory: string) {
  const rawEnvelope = typedUIFixture();
  const artifact = {
    artifact_id: TYPED_UI_TEST_RECEIPT_CONTEXT.artifactId,
    conversation_id: TYPED_UI_TEST_RECEIPT_CONTEXT.conversationId,
    source_message_id: TYPED_UI_TEST_RECEIPT_CONTEXT.sourceMessageId,
    created_at: Date.parse(rawEnvelope.provenance.generated_at),
  };
  const envelope = bindTypedUIEnvelopeToArtifact(rawEnvelope, artifact);
  const completionLedgerPath = path.join(directory, 'audit', 'provider-completions.jsonl');
  const generationLedgerPath = path.join(directory, 'audit', 'generation.jsonl');
  const attestationAuditPath = path.join(directory, 'audit', 'attestation.jsonl');
  const completion = appendMainOwnedTypedUIProviderCompletionReceipt(completionLedgerPath, {
    version: TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION,
    session_id: 'session-receipt',
    provider: 'actual-provider',
    model: 'actual-model',
    provider_request_id: 'provider-request',
    tool_call_id: 'call-receipt',
    raw_content_sha256: hashTypedUIEnvelope(rawEnvelope),
    route_receipt: {
      receipt_id: 'route-receipt',
      route: 'provider-neutral',
      status: 'completed',
      terminal: 'openai_json',
      http_status: 200,
    },
    seat_id: ACTIVE_SEAT_ID,
    seat_context_revision: SEAT_CONTEXT_REVISION,
    completed_at: envelope.provenance.generated_at,
  });
  appendTrustedTypedUIGenerationReceipt(generationLedgerPath, completionLedgerPath, {
    version: TYPED_UI_GENERATION_RECEIPT_VERSION,
    completed_route_receipt_id: completion.completion_receipt_id,
    ...artifact,
    content_sha256: hashTypedUIEnvelope(envelope),
    tool_call_id: 'call-receipt',
    raw_content_sha256: hashTypedUIEnvelope(rawEnvelope),
  });
  const attestation = appendTypedUIProvenanceAttestation(
    attestationAuditPath,
    generationLedgerPath,
    {
      version: TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
      envelope,
      artifact,
    },
    { activeSeatId: ACTIVE_SEAT_ID, seatContextRevision: SEAT_CONTEXT_REVISION }
  );
  expect(attestation.status).toBe('verified');
  return { attestation, attestationAuditPath, envelope };
}

function authorizeRequest(
  evidence: ReturnType<typeof createEvidence>,
  actionId = 'openRun',
  actionType = evidence.envelope.actions[actionId]?.type,
  params = evidence.envelope.actions[actionId]?.params
): TypedUIActionAuthorizeRequest {
  if (!actionType || !params) throw new Error('missing fixture action');
  return {
    version: TYPED_UI_ACTION_AUTHORIZATION_VERSION,
    phase: 'authorize',
    request_id: evidence.envelope.provenance.request_id,
    artifact_id: TYPED_UI_TEST_RECEIPT_CONTEXT.artifactId,
    conversation_id: TYPED_UI_TEST_RECEIPT_CONTEXT.conversationId,
    attestation_id: evidence.attestation.attestation_id,
    content_sha256: evidence.attestation.content_sha256,
    source_message_id: TYPED_UI_TEST_RECEIPT_CONTEXT.sourceMessageId,
    action_id: actionId,
    action_type: actionType,
    params,
  };
}

function paths(directory: string) {
  return {
    auditPath: path.join(directory, 'audit', 'typed-ui-actions.jsonl'),
    gateAuditPath: path.join(directory, 'audit', 'gate-decisions.jsonl'),
    intentClaimDirectory: path.join(directory, 'audit', 'typed-ui-action-intents'),
  };
}

function coreOptions(directory: string, attestationAuditPath: string) {
  let sequence = 1;
  return {
    attestationAuditPath,
    activeSeatId: ACTIVE_SEAT_ID,
    seatContextRevision: SEAT_CONTEXT_REVISION,
    executionMode: 'observed' as const,
    gateAuditPath: paths(directory).gateAuditPath,
    intentClaimDirectory: paths(directory).intentClaimDirectory,
    now: () => new Date('2026-08-11T12:00:02.000Z'),
    randomUUID: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
  };
}

function records(auditPath: string): Array<TypedUIActionReceipt & { receipt_id: string; recorded_at: string }> {
  return fs
    .readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function workspace(prefix = 'typed-ui-receipt-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe('Main-owned Typed UI action authorization and receipts', () => {
  it('persists an exclusive intent before a correlated terminal outcome without raw params', () => {
    const directory = workspace();
    const evidence = createEvidence(directory);
    const target = paths(directory);
    const options = coreOptions(directory, evidence.attestationAuditPath);
    const intent = authorizeTypedUIAction(target.auditPath, authorizeRequest(evidence), options);
    expect(intent.status).toBe('authorized');
    expect(intent.intent_claim_id).toMatch(/^tuic_/);
    const claimPath = path.join(target.intentClaimDirectory, `${intent.intent_claim_id}.json`);
    expect(fs.statSync(claimPath).mode & 0o777).toBe(0o600);
    const finalizeRequest = {
      version: TYPED_UI_ACTION_AUTHORIZATION_VERSION,
      phase: 'finalize' as const,
      intent_receipt_id: intent.receipt_id,
      intent_claim_id: intent.intent_claim_id as string,
      outcome: 'completed' as const,
    };
    const completed = finalizeTypedUIAction(target.auditPath, finalizeRequest, options);
    expect(completed.intent_receipt_id).toBe(intent.receipt_id);
    expect(fs.existsSync(claimPath)).toBe(false);
    const persisted = records(target.auditPath);
    expect(persisted.map((record) => record.status)).toEqual(['authorized', 'completed']);
    expect(persisted[0].decided_at).toBe(persisted[1].decided_at);
    expect(finalizeTypedUIAction(target.auditPath, finalizeRequest, options).receipt_id).toBe(completed.receipt_id);
    expect(records(target.auditPath)).toHaveLength(2);
    const wire = fs.readFileSync(target.auditPath, 'utf8');
    expect(wire).not.toContain('artifact_kind');
    expect(wire).not.toContain('run-41');
    expect(fs.statSync(target.auditPath).mode & 0o777).toBe(0o600);
  });

  it('rejects forged source, undeclared action, type substitution and params mutation', () => {
    const directory = workspace('typed-ui-receipt-forgery-');
    const evidence = createEvidence(directory);
    const target = paths(directory);
    const options = coreOptions(directory, evidence.attestationAuditPath);
    expect(() =>
      authorizeTypedUIAction(
        target.auditPath,
        { ...authorizeRequest(evidence), source_message_id: 'message-from-another-turn' },
        options
      )
    ).toThrow('attestation.source_message_mismatch');
    expect(() =>
      authorizeTypedUIAction(
        target.auditPath,
        {
          ...authorizeRequest(evidence),
          action_id: 'ActionIdNotInEnvelope',
          action_type: 'open_url',
          params: { url: 'https://example.com' },
        },
        options
      )
    ).toThrow('attestation.action_not_found');
    expect(() =>
      authorizeTypedUIAction(
        target.auditPath,
        { ...authorizeRequest(evidence), action_type: 'open_url', params: { url: 'https://example.com' } },
        options
      )
    ).toThrow('attestation.action_type_mismatch');
    expect(() =>
      authorizeTypedUIAction(
        target.auditPath,
        { ...authorizeRequest(evidence), params: { artifact_kind: 'worker', artifact_id: 'other-run' } },
        options
      )
    ).toThrow('attestation.action_params_mismatch');
    expect(fs.existsSync(target.gateAuditPath)).toBe(false);
    expect(fs.existsSync(target.intentClaimDirectory)).toBe(false);
  });

  it('rejects duplicate outstanding intent atomically, then allows reuse after terminal', () => {
    const directory = workspace('typed-ui-receipt-duplicate-');
    const evidence = createEvidence(directory);
    const target = paths(directory);
    const options = coreOptions(directory, evidence.attestationAuditPath);
    const request = authorizeRequest(evidence);
    const first = authorizeTypedUIAction(target.auditPath, request, options);
    expect(() => authorizeTypedUIAction(target.auditPath, request, options)).toThrow('receipt.intent_outstanding');
    finalizeTypedUIAction(
      target.auditPath,
      {
        version: TYPED_UI_ACTION_AUTHORIZATION_VERSION,
        phase: 'finalize',
        intent_receipt_id: first.receipt_id,
        intent_claim_id: first.intent_claim_id,
        outcome: 'completed',
      },
      options
    );
    expect(authorizeTypedUIAction(target.auditPath, request, options).status).toBe('authorized');
  });

  it('allows different attested action bindings to remain concurrently outstanding', () => {
    const directory = workspace('typed-ui-receipt-parallel-');
    const evidence = createEvidence(directory);
    const target = paths(directory);
    const options = coreOptions(directory, evidence.attestationAuditPath);
    const open = authorizeTypedUIAction(target.auditPath, authorizeRequest(evidence, 'openRun'), options);
    const reply = authorizeTypedUIAction(target.auditPath, authorizeRequest(evidence, 'replyState'), options);
    expect(open.intent_claim_id).not.toBe(reply.intent_claim_id);
    expect(fs.readdirSync(target.intentClaimDirectory)).toHaveLength(2);
  });

  it('authorizes only the exact Main-minted host Workbench binding', () => {
    const directory = workspace('typed-ui-receipt-workbench-');
    const evidence = createEvidence(directory);
    const target = paths(directory);
    const options = coreOptions(directory, evidence.attestationAuditPath);
    const base = {
      ...authorizeRequest(evidence),
      action_id: 'host-open-workbench',
      action_type: 'open_artifact' as const,
    };
    expect(() =>
      authorizeTypedUIAction(
        target.auditPath,
        { ...base, params: { artifact_kind: 'file', artifact_id: TYPED_UI_TEST_RECEIPT_CONTEXT.artifactId } },
        options
      )
    ).toThrow('attestation.action_params_mismatch');
    expect(
      authorizeTypedUIAction(
        target.auditPath,
        { ...base, params: { artifact_kind: 'chat', artifact_id: TYPED_UI_TEST_RECEIPT_CONTEXT.artifactId } },
        options
      ).status
    ).toBe('authorized');
  });

  it('reconciles a leftover claim only when its terminal receipt is already durable', () => {
    const directory = workspace('typed-ui-receipt-reconcile-');
    const evidence = createEvidence(directory);
    const target = paths(directory);
    const options = coreOptions(directory, evidence.attestationAuditPath);
    const request = authorizeRequest(evidence);
    const intent = authorizeTypedUIAction(target.auditPath, request, options);
    const claimPath = path.join(target.intentClaimDirectory, `${intent.intent_claim_id}.json`);
    const staleMarker = fs.readFileSync(claimPath);
    finalizeTypedUIAction(
      target.auditPath,
      {
        version: TYPED_UI_ACTION_AUTHORIZATION_VERSION,
        phase: 'finalize',
        intent_receipt_id: intent.receipt_id,
        intent_claim_id: intent.intent_claim_id,
        outcome: 'completed',
      },
      options
    );
    fs.writeFileSync(claimPath, staleMarker, { mode: 0o600 });
    const next = authorizeTypedUIAction(target.auditPath, request, options);
    expect(next.status).toBe('authorized');
    expect(next.receipt_id).not.toBe(intent.receipt_id);
  });

  it('recovers pre-ledger and partial crash markers that could never authorize an effect', () => {
    const directory = workspace('typed-ui-receipt-orphan-');
    const evidence = createEvidence(directory);
    const target = paths(directory);
    const options = coreOptions(directory, evidence.attestationAuditPath);
    const request = authorizeRequest(evidence);
    const first = authorizeTypedUIAction(target.auditPath, request, options);
    const claimPath = path.join(target.intentClaimDirectory, `${first.intent_claim_id}.json`);

    fs.unlinkSync(target.auditPath);
    const afterOrphan = authorizeTypedUIAction(target.auditPath, request, options);
    expect(afterOrphan.status).toBe('authorized');
    expect(afterOrphan.receipt_id).not.toBe(first.receipt_id);

    fs.unlinkSync(target.auditPath);
    fs.writeFileSync(claimPath, '{partial', { mode: 0o600 });
    const afterPartial = authorizeTypedUIAction(target.auditPath, request, options);
    expect(afterPartial.status).toBe('authorized');
    expect(afterPartial.receipt_id).not.toBe(afterOrphan.receipt_id);
  });

  it('reconstructs a lost marker from the durable authorized ledger and remains outstanding', () => {
    const directory = workspace('typed-ui-receipt-lost-marker-');
    const evidence = createEvidence(directory);
    const target = paths(directory);
    const options = coreOptions(directory, evidence.attestationAuditPath);
    const request = authorizeRequest(evidence);
    const intent = authorizeTypedUIAction(target.auditPath, request, options);
    const claimPath = path.join(target.intentClaimDirectory, `${intent.intent_claim_id}.json`);
    fs.unlinkSync(claimPath);
    expect(() => authorizeTypedUIAction(target.auditPath, request, options)).toThrow('receipt.intent_outstanding');
    expect(fs.existsSync(claimPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(claimPath, 'utf8')).intent.receipt_id).toBe(intent.receipt_id);
    expect(
      finalizeTypedUIAction(
        target.auditPath,
        {
          version: TYPED_UI_ACTION_AUTHORIZATION_VERSION,
          phase: 'finalize',
          intent_receipt_id: intent.receipt_id,
          intent_claim_id: intent.intent_claim_id,
          outcome: 'completed',
        },
        options
      ).status
    ).toBe('completed');
  });

  it('fails closed before authority when the receipt ledger is corrupt or exceeds its bound', () => {
    const corruptDirectory = workspace('typed-ui-receipt-corrupt-');
    const corruptEvidence = createEvidence(corruptDirectory);
    const corruptTarget = paths(corruptDirectory);
    fs.mkdirSync(path.dirname(corruptTarget.auditPath), { recursive: true });
    fs.writeFileSync(corruptTarget.auditPath, '{not-json}\n');
    expect(() =>
      authorizeTypedUIAction(
        corruptTarget.auditPath,
        authorizeRequest(corruptEvidence),
        coreOptions(corruptDirectory, corruptEvidence.attestationAuditPath)
      )
    ).toThrow('receipt.ledger_corrupt');
    expect(fs.existsSync(corruptTarget.gateAuditPath)).toBe(false);
    expect(fs.existsSync(corruptTarget.intentClaimDirectory)).toBe(false);

    const oversizedDirectory = workspace('typed-ui-receipt-oversized-');
    const oversizedEvidence = createEvidence(oversizedDirectory);
    const oversizedTarget = paths(oversizedDirectory);
    fs.mkdirSync(path.dirname(oversizedTarget.auditPath), { recursive: true });
    fs.writeFileSync(oversizedTarget.auditPath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    expect(() =>
      authorizeTypedUIAction(
        oversizedTarget.auditPath,
        authorizeRequest(oversizedEvidence),
        coreOptions(oversizedDirectory, oversizedEvidence.attestationAuditPath)
      )
    ).toThrow('receipt.ledger_too_large');
    expect(fs.existsSync(oversizedTarget.gateAuditPath)).toBe(false);
    expect(fs.existsSync(oversizedTarget.intentClaimDirectory)).toBe(false);
  });

  it.each(['goal_control', 'worker_control'] as const)(
    'rejects renderer-forged %s before authority, state or receipt',
    (actionType) => {
      const directory = workspace('typed-ui-receipt-lifecycle-');
      const evidence = createEvidence(directory);
      const target = paths(directory);
      const options = coreOptions(directory, evidence.attestationAuditPath);
      expect(() =>
        authorizeTypedUIAction(target.auditPath, { ...authorizeRequest(evidence), action_type: actionType }, options)
      ).toThrow('receipt.authorize_invalid');
      expect(fs.existsSync(target.auditPath)).toBe(false);
      expect(fs.existsSync(target.gateAuditPath)).toBe(false);
    }
  );

  it('records request_approval using Main current mode without creating an active intent', () => {
    const directory = workspace('typed-ui-receipt-approval-');
    const evidence = createEvidence(directory);
    const target = paths(directory);
    const options = { ...coreOptions(directory, evidence.attestationAuditPath), executionMode: 'autonomous' as const };
    const receipt = authorizeTypedUIAction(target.auditPath, authorizeRequest(evidence, 'requestApproval'), options);
    expect(receipt.status).toBe('blocked');
    expect(receipt.authority).toMatchObject({ mode: 'autonomous', action: 'prepare_pr', allowed: false });
    expect(fs.existsSync(target.intentClaimDirectory)).toBe(false);
  });

  it('rejects malformed authorize/finalize shapes and old generic receipt submissions', () => {
    expect(() => validateTypedUIActionReceiptRequest({ version: 'command-eve.typed-ui-action-receipt/v1' })).toThrow(
      'receipt.finalize_version'
    );
    expect(() =>
      validateTypedUIActionReceiptRequest({
        version: TYPED_UI_ACTION_AUTHORIZATION_VERSION,
        phase: 'finalize',
        intent_receipt_id: 'not-a-uuid',
        intent_claim_id: `tuic_${'a'.repeat(64)}`,
        outcome: 'completed',
      })
    ).toThrow('receipt.finalize_invalid');
  });

  it('routes renderer execution through Main authorize/finalize before the host effect', async () => {
    const directory = workspace('typed-ui-receipt-renderer-main-');
    const evidence = createEvidence(directory);
    const target = paths(directory);
    const options = coreOptions(directory, evidence.attestationAuditPath);
    const store = createStateStore(evidence.envelope.state);
    const openArtifact = vi.fn();
    const host: TypedUIActionHost = {
      attestProvenance: async () => evidence.attestation,
      authorizeAction: async (request) => authorizeTypedUIAction(target.auditPath, request, options),
      finalizeAction: async (request) => finalizeTypedUIAction(target.auditPath, request, options),
      getActionAvailability: (action) => ({
        available: action !== 'goal_control' && action !== 'worker_control',
      }),
      openArtifact,
      openUrl: vi.fn(),
      replyWithState: vi.fn(),
    };
    const handlers = createTypedUIActionHandlers({
      envelope: evidence.envelope,
      attestation: evidence.attestation,
      receiptContext: TYPED_UI_TEST_RECEIPT_CONTEXT,
      store,
      host,
      onReceipt: vi.fn(),
    });
    await handlers.open_artifact({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'openRun',
      artifact_kind: 'worker',
      artifact_id: 'run-41',
    });
    expect(openArtifact).toHaveBeenCalledWith('worker', 'run-41');
    expect(records(target.auditPath).map((record) => record.status)).toEqual(['authorized', 'completed']);
  });
});
