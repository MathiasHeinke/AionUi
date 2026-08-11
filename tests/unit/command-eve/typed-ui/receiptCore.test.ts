/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { TYPED_UI_PROVENANCE_ATTESTATION_VERSION, type TypedUIActionReceipt } from '@/common/typedUI';
import {
  appendTypedUIActionReceipt,
  validateTypedUIActionReceipt,
} from '@/process/commandEve/typedUIActionReceiptCore';
import { evaluateCommandEveGateDecision } from '@/process/commandEve/executionModeCore';
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
import { TYPED_UI_TEST_RECEIPT_CONTEXT, typedUIAttestationFixture, typedUIFixture } from './fixtures';

const temporaryDirectories: string[] = [];
const ACTIVE_SEAT_ID = 'seat-typed-ui';
const SEAT_CONTEXT_REVISION = 7;

function createEvidence(directory: string) {
  const envelope = typedUIFixture();
  const completionLedgerPath = path.join(directory, 'audit', 'typed-ui-provider-completions.jsonl');
  const generationLedgerPath = path.join(directory, 'audit', 'typed-ui-generations.jsonl');
  const attestationAuditPath = path.join(directory, 'audit', 'typed-ui-provenance.jsonl');
  const completion = appendMainOwnedTypedUIProviderCompletionReceipt(completionLedgerPath, {
    version: TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION,
    session_id: 'session-receipt-core',
    provider: envelope.provenance.provider,
    model: envelope.provenance.model,
    request_id: envelope.provenance.request_id,
    route_receipt: { receipt_id: 'route-receipt-17', route: 'provider-neutral', status: 'completed' },
    seat_id: ACTIVE_SEAT_ID,
    seat_context_revision: SEAT_CONTEXT_REVISION,
    completed_at: envelope.provenance.generated_at,
  });
  appendTrustedTypedUIGenerationReceipt(generationLedgerPath, completionLedgerPath, {
    version: TYPED_UI_GENERATION_RECEIPT_VERSION,
    completed_route_receipt_id: completion.completion_receipt_id,
    artifact_id: TYPED_UI_TEST_RECEIPT_CONTEXT.artifactId,
    conversation_id: TYPED_UI_TEST_RECEIPT_CONTEXT.conversationId,
    source_message_id: TYPED_UI_TEST_RECEIPT_CONTEXT.sourceMessageId,
    created_at: Date.parse(envelope.provenance.generated_at),
    content_sha256: hashTypedUIEnvelope(envelope),
  });
  const attestation = appendTypedUIProvenanceAttestation(
    attestationAuditPath,
    generationLedgerPath,
    {
      version: TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
      envelope,
      artifact: {
        artifact_id: TYPED_UI_TEST_RECEIPT_CONTEXT.artifactId,
        conversation_id: TYPED_UI_TEST_RECEIPT_CONTEXT.conversationId,
        source_message_id: TYPED_UI_TEST_RECEIPT_CONTEXT.sourceMessageId,
        created_at: Date.parse(envelope.provenance.generated_at),
      },
    },
    { activeSeatId: ACTIVE_SEAT_ID, seatContextRevision: SEAT_CONTEXT_REVISION }
  );
  expect(attestation.status).toBe('verified');
  return { attestation, attestationAuditPath, envelope };
}

function receipt(
  attestation = typedUIAttestationFixture(),
  status: TypedUIActionReceipt['status'] = 'authorized'
): TypedUIActionReceipt {
  const authority = evaluateCommandEveGateDecision({
    mode: 'observed',
    action: 'truth_gate',
    now: () => new Date('2026-08-11T12:00:00.000Z'),
  });
  return {
    version: 'command-eve.typed-ui-action-receipt/v1',
    request_id: 'req-fixture-1',
    artifact_id: TYPED_UI_TEST_RECEIPT_CONTEXT.artifactId,
    conversation_id: TYPED_UI_TEST_RECEIPT_CONTEXT.conversationId,
    attestation_id: attestation.attestation_id,
    content_sha256: attestation.content_sha256,
    source_message_id: TYPED_UI_TEST_RECEIPT_CONTEXT.sourceMessageId,
    action_id: 'openRun',
    action_type: 'open_artifact',
    status,
    decided_at: authority.decided_at,
    authority,
  };
}

function appendOptions(attestationAuditPath: string, randomUUID?: () => string) {
  return {
    attestationAuditPath,
    activeSeatId: ACTIVE_SEAT_ID,
    seatContextRevision: SEAT_CONTEXT_REVISION,
    ...(randomUUID ? { randomUUID } : {}),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Main-owned Typed UI action receipts', () => {
  it('persists a private intent before a correlated terminal outcome', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-ui-receipt-'));
    temporaryDirectories.push(directory);
    const evidence = createEvidence(directory);
    const auditPath = path.join(directory, 'audit', 'typed-ui-actions.jsonl');
    const intent = appendTypedUIActionReceipt(auditPath, receipt(evidence.attestation), {
      ...appendOptions(evidence.attestationAuditPath),
      now: () => new Date('2026-08-11T12:00:02.000Z'),
      randomUUID: () => '00000000-0000-4000-8000-000000000001',
    });
    const completed = appendTypedUIActionReceipt(
      auditPath,
      { ...receipt(evidence.attestation, 'completed'), intent_receipt_id: intent.receipt_id },
      {
        ...appendOptions(evidence.attestationAuditPath),
        now: () => new Date('2026-08-11T12:00:03.000Z'),
        randomUUID: () => '00000000-0000-4000-8000-000000000002',
      }
    );
    expect(completed.intent_receipt_id).toBe(intent.receipt_id);
    const records = fs
      .readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.status)).toEqual(['authorized', 'completed']);
    expect(fs.statSync(auditPath).mode & 0o777).toBe(0o600);
  });

  it('rejects forged authority fields, unknown actions and terminal records without intent', () => {
    const missingSource = { ...receipt() } as Record<string, unknown>;
    delete missingSource.source_message_id;
    expect(validateTypedUIActionReceipt(missingSource)).toEqual({
      ok: false,
      reason: 'receipt.source_message_id',
    });

    const extraAuthority = receipt();
    (extraAuthority.authority as typeof extraAuthority.authority & { forged?: boolean }).forged = true;
    expect(validateTypedUIActionReceipt(extraAuthority)).toEqual({ ok: false, reason: 'receipt.authority_shape' });

    const unknownAction = receipt();
    (unknownAction.authority as { action: string }).action = 'arbitrary';
    expect(validateTypedUIActionReceipt(unknownAction)).toEqual({ ok: false, reason: 'receipt.authority_shape' });

    expect(validateTypedUIActionReceipt(receipt(undefined, 'completed'))).toEqual({
      ok: false,
      reason: 'receipt.missing_intent',
    });
  });

  it.each(['goal_control', 'worker_control'] as const)(
    'rejects renderer-forged %s receipts until a canonical Main transport is committed',
    (actionType) => {
      expect(validateTypedUIActionReceipt({ ...receipt(), action_type: actionType })).toEqual({
        ok: false,
        reason: 'receipt.action_type',
      });
    }
  );

  it('rejects missing, mismatched and replayed durable intent references', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-ui-receipt-correlation-'));
    temporaryDirectories.push(directory);
    const evidence = createEvidence(directory);
    const auditPath = path.join(directory, 'audit', 'typed-ui-actions.jsonl');
    const options = appendOptions(evidence.attestationAuditPath);
    const forgedTerminal = {
      ...receipt(evidence.attestation, 'completed'),
      intent_receipt_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    };
    expect(() => appendTypedUIActionReceipt(auditPath, forgedTerminal, options)).toThrow('receipt.intent_not_found');

    const intent = appendTypedUIActionReceipt(auditPath, receipt(evidence.attestation), {
      ...options,
      randomUUID: () => '00000000-0000-4000-8000-000000000010',
    });
    expect(() =>
      appendTypedUIActionReceipt(
        auditPath,
        {
          ...receipt(evidence.attestation, 'completed'),
          action_id: 'differentAction',
          intent_receipt_id: intent.receipt_id,
        },
        options
      )
    ).toThrow('receipt.intent_mismatch');

    appendTypedUIActionReceipt(
      auditPath,
      { ...receipt(evidence.attestation, 'completed'), intent_receipt_id: intent.receipt_id },
      { ...options, randomUUID: () => '00000000-0000-4000-8000-000000000011' }
    );
    expect(() =>
      appendTypedUIActionReceipt(
        auditPath,
        { ...receipt(evidence.attestation, 'failed'), intent_receipt_id: intent.receipt_id },
        { ...options, randomUUID: () => '00000000-0000-4000-8000-000000000012' }
      )
    ).toThrow('receipt.intent_already_terminal');
  });

  it('rejects action receipts whose content hash does not match the immutable attestation', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-ui-receipt-attestation-'));
    temporaryDirectories.push(directory);
    const evidence = createEvidence(directory);
    const auditPath = path.join(directory, 'audit', 'typed-ui-actions.jsonl');
    expect(() =>
      appendTypedUIActionReceipt(
        auditPath,
        { ...receipt(evidence.attestation), content_sha256: 'f'.repeat(64) },
        appendOptions(evidence.attestationAuditPath)
      )
    ).toThrow('attestation.content_mismatch');
  });

  it('persists one renderer intent and terminal outcome with the same authority timestamp', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-ui-receipt-renderer-main-'));
    temporaryDirectories.push(directory);
    const evidence = createEvidence(directory);
    const auditPath = path.join(directory, 'audit', 'typed-ui-actions.jsonl');
    const store = createStateStore(evidence.envelope.state);
    const openArtifact = vi.fn();
    let sequence = 20;
    const host: TypedUIActionHost = {
      attestProvenance: async () => evidence.attestation,
      evaluateAuthority: async (action) =>
        evaluateCommandEveGateDecision({
          mode: 'observed',
          action,
          now: () => new Date('2026-08-11T12:00:00.000Z'),
        }),
      recordReceipt: async (value) => {
        const persisted = appendTypedUIActionReceipt(auditPath, value, {
          ...appendOptions(evidence.attestationAuditPath),
          randomUUID: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
        });
        return { receipt_id: persisted.receipt_id };
      },
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
    const records = fs
      .readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TypedUIActionReceipt);
    expect(records.map((record) => record.status)).toEqual(['authorized', 'completed']);
    expect(records[0].decided_at).toBe(records[1].decided_at);
  });
});
