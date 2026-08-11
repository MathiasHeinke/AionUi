/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { TYPED_UI_PROVENANCE_ATTESTATION_VERSION, type TypedUIEnvelope } from '@/common/typedUI';
import {
  appendMainOwnedTypedUIProviderCompletionReceipt,
  appendTrustedTypedUIGenerationReceipt,
  appendTypedUIProvenanceAttestation,
  hashTypedUIEnvelope,
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

function providerCompletion(target: ReturnType<typeof workspace>, envelope = typedUIFixture(), suffix = '') {
  return appendMainOwnedTypedUIProviderCompletionReceipt(target.completionPath, {
    version: TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION,
    session_id: `session-attested${suffix}`,
    provider: envelope.provenance.provider,
    model: envelope.provenance.model,
    request_id: `${envelope.provenance.request_id}${suffix}`,
    route_receipt: {
      receipt_id: `route-receipt-attested${suffix}`,
      route: 'provider-neutral',
      status: 'completed',
    },
    seat_id: seat.activeSeatId,
    seat_context_revision: seat.seatContextRevision,
    completed_at: envelope.provenance.generated_at,
  });
}

function joinReceipt(
  target: ReturnType<typeof workspace>,
  envelope: TypedUIEnvelope,
  completion: ReturnType<typeof providerCompletion>
) {
  return appendTrustedTypedUIGenerationReceipt(target.generationPath, target.completionPath, {
    version: TYPED_UI_GENERATION_RECEIPT_VERSION,
    completed_route_receipt_id: completion.completion_receipt_id,
    ...artifactRef(envelope),
    content_sha256: hashTypedUIEnvelope(envelope),
  });
}

function trustedReceipt(target: ReturnType<typeof workspace>, envelope = typedUIFixture()) {
  return joinReceipt(target, envelope, providerCompletion(target, envelope));
}

function attest(
  target: ReturnType<typeof workspace>,
  envelope = typedUIFixture(),
  artifact = artifactRef(envelope),
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
    const record = attest(target, envelope);
    expect(record.status).toBe('verified');
    expect(record.receipt_sha256).toBe(generation.route_receipt_sha256);
    expect(JSON.stringify(record)).not.toContain(envelope.provenance.provider);
    expect(JSON.stringify(record)).not.toContain(envelope.provenance.model);

    const ledgers = `${fs.readFileSync(target.completionPath, 'utf8')}\n${fs.readFileSync(
      target.generationPath,
      'utf8'
    )}\n${fs.readFileSync(target.attestationPath, 'utf8')}`;
    expect(ledgers).not.toContain(envelope.provenance.provider);
    expect(ledgers).not.toContain(envelope.provenance.model);
    expect(ledgers).not.toContain(envelope.provenance.request_id);
    expect(ledgers).not.toContain('route-receipt-attested');
  });

  it('requires a real private completion record and consumes it for exactly one artifact join', () => {
    const target = workspace();
    const envelope = typedUIFixture();
    expect(() =>
      appendTrustedTypedUIGenerationReceipt(target.generationPath, target.completionPath, {
        version: TYPED_UI_GENERATION_RECEIPT_VERSION,
        completed_route_receipt_id: `tuipc_${'f'.repeat(64)}`,
        ...artifactRef(envelope),
        content_sha256: hashTypedUIEnvelope(envelope),
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
        content_sha256: hashTypedUIEnvelope(envelope),
      })
    ).toThrow('attestation.provider_completion_consumed');
  });

  it('fails closed instead of forgetting replay history when a private ledger exceeds its verification bound', () => {
    const target = workspace();
    fs.mkdirSync(path.dirname(target.completionPath), { recursive: true });
    fs.writeFileSync(target.completionPath, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
    expect(() => providerCompletion(target)).toThrow('attestation.ledger_too_large');
  });

  it.each([
    ['provider_mismatch', (value: TypedUIEnvelope) => (value.provenance.provider = 'other-provider')],
    ['model_mismatch', (value: TypedUIEnvelope) => (value.provenance.model = 'other-model')],
    ['request_mismatch', (value: TypedUIEnvelope) => (value.provenance.request_id = 'other-request')],
    ['content_mismatch', (value: TypedUIEnvelope) => (value.elements.heading.props.text = 'mutated after receipt')],
  ] as const)('rejects %s against immutable receipt hashes', (reason, mutate) => {
    const target = workspace();
    trustedReceipt(target);
    const candidate = typedUIFixture();
    mutate(candidate);
    expect(attest(target, candidate)).toMatchObject({ status: 'rejected', reason });
  });

  it('rejects source, seat, revision and artifact-time replay', () => {
    const sourceTarget = workspace();
    trustedReceipt(sourceTarget);
    expect(
      attest(sourceTarget, typedUIFixture(), { ...artifactRef(typedUIFixture()), source_message_id: 'other' })
    ).toMatchObject({ status: 'rejected', reason: 'source_message_mismatch' });

    const seatTarget = workspace();
    trustedReceipt(seatTarget);
    expect(
      attest(seatTarget, typedUIFixture(), artifactRef(typedUIFixture()), { ...seat, activeSeatId: 'seat-other' })
    ).toMatchObject({ status: 'rejected', reason: 'seat_mismatch' });

    const revisionTarget = workspace();
    trustedReceipt(revisionTarget);
    expect(
      attest(revisionTarget, typedUIFixture(), artifactRef(typedUIFixture()), {
        ...seat,
        seatContextRevision: seat.seatContextRevision + 1,
      })
    ).toMatchObject({ status: 'rejected', reason: 'seat_revision_mismatch' });

    const timeTarget = workspace();
    trustedReceipt(timeTarget);
    expect(
      attest(timeTarget, typedUIFixture(), { ...artifactRef(typedUIFixture()), created_at: Date.now() })
    ).toMatchObject({ status: 'rejected', reason: 'artifact_time_mismatch' });
  });

  it('revalidates the current content and seat correlation before every action receipt', () => {
    const target = workspace();
    const envelope = typedUIFixture();
    trustedReceipt(target, envelope);
    const record = attest(target, envelope);
    expect(() =>
      requireVerifiedTypedUIProvenanceAttestation(target.attestationPath, {
        attestationId: record.attestation_id,
        artifactId: record.artifact_id,
        conversationId: record.conversation_id,
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
        requestId: envelope.provenance.request_id,
        contentSha256: 'f'.repeat(64),
        activeSeatId: seat.activeSeatId,
        seatContextRevision: seat.seatContextRevision,
      })
    ).toThrow('attestation.content_mismatch');
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
