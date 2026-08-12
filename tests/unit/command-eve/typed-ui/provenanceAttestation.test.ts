/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  bindTypedUIEnvelopeToArtifact,
  TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
  type TypedUIEnvelope,
} from '@/common/typedUI';
import {
  appendMainOwnedTypedUIProviderCompletionReceipt,
  appendTrustedTypedUIGenerationReceipt,
  appendTypedUIProvenanceAttestation,
  hashTypedUIEnvelope,
  requireVerifiedTypedUIActionBinding,
  requireVerifiedTypedUIProvenanceAttestation,
  TYPED_UI_GENERATION_RECEIPT_VERSION,
  TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION,
} from '@/process/commandEve/typedUIProvenanceAttestationCore';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TYPED_UI_TEST_RECEIPT_CONTEXT, typedUIFixture } from './fixtures';

const temporaryDirectories: string[] = [];
const seat = { activeSeatId: 'seat-attestation', seatContextRevision: 11 };

function workspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-ui-provenance-'));
  temporaryDirectories.push(directory);
  return {
    directory,
    completionPath: path.join(directory, 'audit', 'typed-ui-provider-completions.jsonl'),
    generationPath: path.join(directory, 'audit', 'typed-ui-generations.jsonl'),
    attestationPath: path.join(directory, 'audit', 'typed-ui-provenance.jsonl'),
  };
}

function artifactRef(envelope: TypedUIEnvelope) {
  return {
    artifact_id: TYPED_UI_TEST_RECEIPT_CONTEXT.artifactId,
    conversation_id: TYPED_UI_TEST_RECEIPT_CONTEXT.conversationId,
    source_message_id: TYPED_UI_TEST_RECEIPT_CONTEXT.sourceMessageId,
    created_at: Date.parse(envelope.provenance.generated_at),
  };
}

function hostEnvelope(envelope = typedUIFixture(), artifact = artifactRef(envelope)) {
  return bindTypedUIEnvelopeToArtifact(envelope, artifact);
}

function providerCompletion(target: ReturnType<typeof workspace>, envelope = typedUIFixture(), suffix = '') {
  const toolCallId = `call-attested${suffix}`;
  const record = appendMainOwnedTypedUIProviderCompletionReceipt(target.completionPath, {
    version: TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION,
    session_id: `session-attested${suffix}`,
    provider: `actual-provider${suffix}`,
    model: `actual-model${suffix}`,
    provider_request_id: `provider-request${suffix}`,
    tool_call_id: toolCallId,
    raw_content_sha256: hashTypedUIEnvelope(envelope),
    route_receipt: {
      receipt_id: `route-receipt-attested${suffix}`,
      route: 'provider-neutral',
      status: 'completed',
      terminal: 'openai_json',
      http_status: 200,
    },
    seat_id: seat.activeSeatId,
    seat_context_revision: seat.seatContextRevision,
    completed_at: envelope.provenance.generated_at,
  });
  return { ...record, toolCallId };
}

function joinReceipt(
  target: ReturnType<typeof workspace>,
  envelope: TypedUIEnvelope,
  completion: ReturnType<typeof providerCompletion>
) {
  const artifact = artifactRef(envelope);
  return appendTrustedTypedUIGenerationReceipt(target.generationPath, target.completionPath, {
    version: TYPED_UI_GENERATION_RECEIPT_VERSION,
    completed_route_receipt_id: completion.completion_receipt_id,
    ...artifact,
    content_sha256: hashTypedUIEnvelope(hostEnvelope(envelope, artifact)),
    tool_call_id: completion.toolCallId,
    raw_content_sha256: hashTypedUIEnvelope(envelope),
  });
}

function trustedReceipt(target: ReturnType<typeof workspace>, envelope = typedUIFixture()) {
  return joinReceipt(target, envelope, providerCompletion(target, envelope));
}

function attest(
  target: ReturnType<typeof workspace>,
  envelope = hostEnvelope(),
  artifact = artifactRef(typedUIFixture()),
  context = seat
) {
  return appendTypedUIProvenanceAttestation(
    target.attestationPath,
    target.generationPath,
    { version: TYPED_UI_PROVENANCE_ATTESTATION_VERSION, envelope, artifact },
    context
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Main-owned Typed UI provenance attestation', () => {
  it('fails closed when no trusted generation producer has written a receipt', () => {
    const target = workspace();
    const record = attest(target);
    expect(record).toMatchObject({ status: 'rejected', reason: 'trusted_generation_receipt_missing' });
    expect(fs.statSync(target.attestationPath).mode & 0o777).toBe(0o600);
  });

  it('rejects renderer-supplied provider/model/receipt evidence as an unknown artifact field', () => {
    const target = workspace();
    const envelope = typedUIFixture();
    expect(() =>
      appendTypedUIProvenanceAttestation(
        target.attestationPath,
        target.generationPath,
        {
          version: TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
          envelope,
          artifact: {
            ...artifactRef(envelope),
            provider: 'forged-provider',
            model: 'forged-model',
            receipt: { status: 'done' },
          },
        },
        seat
      )
    ).toThrow('attestation.artifact_invalid');
  });

  it('verifies only a matching Main-owned receipt and persists no raw route identity', () => {
    const target = workspace();
    const envelope = typedUIFixture();
    const generation = trustedReceipt(target, envelope);
    const bound = hostEnvelope(envelope);
    const record = attest(target, bound);
    expect(record.status).toBe('verified');
    expect(record.source_message_id).toBe(TYPED_UI_TEST_RECEIPT_CONTEXT.sourceMessageId);
    expect(record.action_set_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record.receipt_sha256).toBe(generation.route_receipt_sha256);
    expect(JSON.stringify(record)).not.toContain('actual-provider');
    expect(JSON.stringify(record)).not.toContain('actual-model');

    const ledgers = `${fs.readFileSync(target.completionPath, 'utf8')}\n${fs.readFileSync(
      target.generationPath,
      'utf8'
    )}\n${fs.readFileSync(target.attestationPath, 'utf8')}`;
    expect(ledgers).not.toContain('actual-provider');
    expect(ledgers).not.toContain('actual-model');
    expect(ledgers).not.toContain('provider-request');
    expect(ledgers).not.toContain('route-receipt-attested');
    expect(fs.readFileSync(target.attestationPath, 'utf8')).not.toContain('artifact_kind');
    expect(fs.readFileSync(target.attestationPath, 'utf8')).not.toContain('run-41');
    expect(fs.readFileSync(target.attestationPath, 'utf8')).not.toContain('goal_control');
    expect(fs.readFileSync(target.attestationPath, 'utf8')).not.toContain('worker_control');
  });

  it('requires a real private completion record and consumes it for exactly one artifact join', () => {
    const target = workspace();
    const envelope = typedUIFixture();
    expect(() =>
      appendTrustedTypedUIGenerationReceipt(target.generationPath, target.completionPath, {
        version: TYPED_UI_GENERATION_RECEIPT_VERSION,
        completed_route_receipt_id: `tuipc_${'f'.repeat(64)}`,
        ...artifactRef(envelope),
        content_sha256: hashTypedUIEnvelope(hostEnvelope(envelope)),
        tool_call_id: 'call-missing',
        raw_content_sha256: hashTypedUIEnvelope(envelope),
      })
    ).toThrow('attestation.provider_completion_missing');

    const completion = providerCompletion(target, envelope);
    joinReceipt(target, envelope, completion);
    expect(() =>
      appendTrustedTypedUIGenerationReceipt(target.generationPath, target.completionPath, {
        version: TYPED_UI_GENERATION_RECEIPT_VERSION,
        completed_route_receipt_id: completion.completion_receipt_id,
        ...artifactRef(envelope),
        artifact_id: 'artifact-other',
        content_sha256: hashTypedUIEnvelope(hostEnvelope(envelope)),
        tool_call_id: completion.toolCallId,
        raw_content_sha256: hashTypedUIEnvelope(envelope),
      })
    ).toThrow('attestation.provider_completion_consumed');
  });

  it('keeps new receipts usable when old private history exceeds the bounded verification tail', () => {
    const target = workspace();
    fs.mkdirSync(path.dirname(target.completionPath), { recursive: true });
    fs.writeFileSync(
      target.completionPath,
      Buffer.concat([Buffer.alloc(8 * 1024 * 1024 + 1, 0x20), Buffer.from('\n')])
    );
    expect(providerCompletion(target).completion_receipt_id).toMatch(/^tuipc_/);
  });

  it('keeps a completion consumed when its old generation line falls outside the bounded tail', () => {
    const target = workspace();
    const envelope = typedUIFixture();
    const completion = providerCompletion(target, envelope);
    const first = joinReceipt(target, envelope, completion);
    fs.appendFileSync(
      target.generationPath,
      Buffer.concat([Buffer.alloc(8 * 1024 * 1024 + 1, 0x20), Buffer.from('\n')])
    );

    // An identical retry repairs the recent generation view from the durable
    // consumption marker without creating a different receipt.
    expect(joinReceipt(target, envelope, completion).receipt_id).toBe(first.receipt_id);

    expect(() =>
      appendTrustedTypedUIGenerationReceipt(target.generationPath, target.completionPath, {
        version: TYPED_UI_GENERATION_RECEIPT_VERSION,
        completed_route_receipt_id: completion.completion_receipt_id,
        ...artifactRef(envelope),
        artifact_id: 'artifact-tail-replay',
        content_sha256: hashTypedUIEnvelope(hostEnvelope(envelope)),
        tool_call_id: completion.toolCallId,
        raw_content_sha256: hashTypedUIEnvelope(envelope),
      })
    ).toThrow('attestation.provider_completion_consumed');
  });

  it.each([
    ['provider_claim_unbound', (value: TypedUIEnvelope) => (value.provenance.provider = 'other-provider')],
    ['model_claim_unbound', (value: TypedUIEnvelope) => (value.provenance.model = 'other-model')],
    ['request_mismatch', (value: TypedUIEnvelope) => (value.provenance.request_id = 'other-request')],
    ['content_mismatch', (value: TypedUIEnvelope) => (value.elements.heading.props.text = 'mutated after receipt')],
  ] as const)('rejects %s against immutable receipt hashes', (reason, mutate) => {
    const target = workspace();
    trustedReceipt(target);
    const candidate = hostEnvelope();
    mutate(candidate);
    expect(attest(target, candidate)).toMatchObject({ status: 'rejected', reason });
  });

  it('rejects source, seat, revision and artifact-time replay', () => {
    const sourceTarget = workspace();
    trustedReceipt(sourceTarget);
    expect(
      attest(sourceTarget, hostEnvelope(), { ...artifactRef(typedUIFixture()), source_message_id: 'other' })
    ).toMatchObject({ status: 'rejected', reason: 'source_message_mismatch' });

    const seatTarget = workspace();
    trustedReceipt(seatTarget);
    expect(
      attest(seatTarget, hostEnvelope(), artifactRef(typedUIFixture()), { ...seat, activeSeatId: 'seat-other' })
    ).toMatchObject({ status: 'rejected', reason: 'seat_mismatch' });

    const revisionTarget = workspace();
    trustedReceipt(revisionTarget);
    expect(
      attest(revisionTarget, hostEnvelope(), artifactRef(typedUIFixture()), {
        ...seat,
        seatContextRevision: seat.seatContextRevision + 1,
      })
    ).toMatchObject({ status: 'rejected', reason: 'seat_revision_mismatch' });

    const timeTarget = workspace();
    trustedReceipt(timeTarget);
    expect(
      attest(timeTarget, hostEnvelope(), { ...artifactRef(typedUIFixture()), created_at: Date.now() })
    ).toMatchObject({ status: 'rejected', reason: 'artifact_time_mismatch' });
  });

  it('revalidates the current content and seat correlation before every action receipt', () => {
    const target = workspace();
    const rawEnvelope = typedUIFixture();
    const envelope = hostEnvelope(rawEnvelope);
    trustedReceipt(target, rawEnvelope);
    const record = attest(target, envelope);
    expect(() =>
      requireVerifiedTypedUIProvenanceAttestation(target.attestationPath, {
        attestationId: record.attestation_id,
        artifactId: record.artifact_id,
        conversationId: record.conversation_id,
        sourceMessageId: TYPED_UI_TEST_RECEIPT_CONTEXT.sourceMessageId,
        requestId: envelope.provenance.request_id,
        contentSha256: record.content_sha256,
        activeSeatId: 'seat-other',
        seatContextRevision: seat.seatContextRevision,
      })
    ).toThrow('attestation.integrity_mismatch');
    expect(() =>
      requireVerifiedTypedUIProvenanceAttestation(target.attestationPath, {
        attestationId: record.attestation_id,
        artifactId: record.artifact_id,
        conversationId: record.conversation_id,
        sourceMessageId: TYPED_UI_TEST_RECEIPT_CONTEXT.sourceMessageId,
        requestId: envelope.provenance.request_id,
        contentSha256: 'f'.repeat(64),
        activeSeatId: seat.activeSeatId,
        seatContextRevision: seat.seatContextRevision,
      })
    ).toThrow('attestation.content_mismatch');
    expect(() =>
      requireVerifiedTypedUIProvenanceAttestation(target.attestationPath, {
        attestationId: record.attestation_id,
        artifactId: record.artifact_id,
        conversationId: record.conversation_id,
        sourceMessageId: 'message-from-another-turn',
        requestId: envelope.provenance.request_id,
        contentSha256: record.content_sha256,
        activeSeatId: seat.activeSeatId,
        seatContextRevision: seat.seatContextRevision,
      })
    ).toThrow('attestation.source_message_mismatch');
  });

  it('binds action id, type and canonical params to the private attestation manifest', () => {
    const target = workspace();
    const rawEnvelope = typedUIFixture();
    const envelope = hostEnvelope(rawEnvelope);
    trustedReceipt(target, rawEnvelope);
    const record = attest(target, envelope);
    const base = {
      attestationId: record.attestation_id,
      artifactId: record.artifact_id,
      conversationId: record.conversation_id,
      sourceMessageId: record.source_message_id,
      requestId: envelope.provenance.request_id,
      contentSha256: record.content_sha256,
      activeSeatId: seat.activeSeatId,
      seatContextRevision: seat.seatContextRevision,
    };
    expect(
      requireVerifiedTypedUIActionBinding(target.attestationPath, {
        ...base,
        actionId: 'openRun',
        actionType: 'open_artifact',
        actionParams: envelope.actions.openRun.params,
      }).binding_sha256
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(() =>
      requireVerifiedTypedUIActionBinding(target.attestationPath, {
        ...base,
        actionId: 'missingAction',
        actionType: 'open_url',
        actionParams: { url: 'https://example.com' },
      })
    ).toThrow('attestation.action_not_found');
    expect(() =>
      requireVerifiedTypedUIActionBinding(target.attestationPath, {
        ...base,
        actionId: 'openRun',
        actionType: 'open_url',
        actionParams: { url: 'https://example.com' },
      })
    ).toThrow('attestation.action_type_mismatch');
    expect(() =>
      requireVerifiedTypedUIActionBinding(target.attestationPath, {
        ...base,
        actionId: 'openRun',
        actionType: 'open_artifact',
        actionParams: { artifact_kind: 'worker', artifact_id: 'other-run' },
      })
    ).toThrow('attestation.action_params_mismatch');
  });

  it('refuses a second trusted receipt for the same immutable artifact identity', () => {
    const target = workspace();
    trustedReceipt(target);
    const mutated = typedUIFixture();
    mutated.elements.heading.props.text = 'different';
    const secondCompletion = providerCompletion(target, mutated, '-second');
    expect(() => joinReceipt(target, mutated, secondCompletion)).toThrow('attestation.generation_receipt_conflict');
  });
});
