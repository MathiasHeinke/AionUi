/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
  validateTypedUIEnvelope,
  type TypedUIEnvelope,
  type TypedUIProvenanceArtifactRef,
  type TypedUIProvenanceAttestation,
  type TypedUIProvenanceAttestationRequest,
} from '@/common/typedUI';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TYPED_UI_GENERATION_RECEIPT_VERSION = 'command-eve.typed-ui-generation-receipt/v1' as const;
export const TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION = 'command-eve.typed-ui-provider-completion/v1' as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ATTESTATION_ID = /^tuia_[a-f0-9]{64}$/;
const GENERATION_RECEIPT_ID = /^tuigr_[a-f0-9]{64}$/;
const PROVIDER_COMPLETION_RECEIPT_ID = /^tuipc_[a-f0-9]{64}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_LEDGER_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_GENERATED_AT_DRIFT_MS = 24 * 60 * 60 * 1000;
const EMPTY_SHA256 = '0'.repeat(64);

export interface MainOwnedTypedUIProviderCompletionInput {
  version: typeof TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION;
  session_id: string;
  provider: string;
  model: string;
  request_id: string;
  route_receipt: {
    receipt_id: string;
    route: string;
    status: 'completed';
  };
  seat_id: string;
  seat_context_revision: number;
  completed_at: string;
}

export interface PersistedTypedUIProviderCompletionReceipt {
  version: typeof TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION;
  completion_receipt_id: string;
  session_id_sha256: string;
  provider_sha256: string;
  model_sha256: string;
  request_id_sha256: string;
  route_receipt_sha256: string;
  seat_id_sha256: string;
  seat_context_revision: number;
  status: 'completed';
  completed_at: string;
  recorded_at: string;
}

export interface TrustedTypedUIGenerationReceiptInput {
  version: typeof TYPED_UI_GENERATION_RECEIPT_VERSION;
  completed_route_receipt_id: string;
  artifact_id: string;
  conversation_id: string;
  source_message_id: string;
  created_at: number;
  content_sha256: string;
}

export interface PersistedTypedUIGenerationReceipt {
  version: typeof TYPED_UI_GENERATION_RECEIPT_VERSION;
  receipt_id: string;
  completed_route_receipt_id: string;
  artifact_id: string;
  conversation_id: string;
  source_message_id: string;
  created_at: number;
  content_sha256: string;
  provider_sha256: string;
  model_sha256: string;
  request_id_sha256: string;
  route_receipt_sha256: string;
  seat_id_sha256: string;
  seat_context_revision: number;
  status: 'completed';
  recorded_at: string;
}

type AttestationContext = {
  activeSeatId: string;
  seatContextRevision: number;
};

const GENERATION_RECORD_KEYS = new Set([
  'version',
  'receipt_id',
  'completed_route_receipt_id',
  'artifact_id',
  'conversation_id',
  'source_message_id',
  'created_at',
  'content_sha256',
  'provider_sha256',
  'model_sha256',
  'request_id_sha256',
  'route_receipt_sha256',
  'seat_id_sha256',
  'seat_context_revision',
  'status',
  'recorded_at',
]);
const PROVIDER_COMPLETION_RECORD_KEYS = new Set([
  'version',
  'completion_receipt_id',
  'session_id_sha256',
  'provider_sha256',
  'model_sha256',
  'request_id_sha256',
  'route_receipt_sha256',
  'seat_id_sha256',
  'seat_context_revision',
  'status',
  'completed_at',
  'recorded_at',
]);
const ATTESTATION_RECORD_KEYS = new Set([
  'version',
  'attestation_id',
  'artifact_id',
  'conversation_id',
  'content_sha256',
  'identity_sha256',
  'request_id_sha256',
  'receipt_sha256',
  'seat_context_revision',
  'status',
  'reason',
  'recorded_at',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key) && !FORBIDDEN_KEYS.has(key));
}

function boundedString(value: unknown, max = 500): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
}

function safeId(value: unknown, max = 256): value is string {
  return boundedString(value, max) && SAFE_ID.test(value);
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000_000;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

export function hashTypedUIEnvelope(envelope: TypedUIEnvelope): string {
  return hashJson(envelope);
}

function appendPrivateJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function readRecentJsonLines(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  const size = fs.statSync(filePath).size;
  if (size === 0) return [];
  if (size > MAX_LEDGER_TAIL_BYTES) throw new Error('attestation.ledger_too_large');
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          throw new Error('attestation.ledger_corrupt');
        }
      });
  } finally {
    fs.closeSync(handle);
  }
}

function validateArtifactRef(value: unknown): value is TypedUIProvenanceArtifactRef {
  if (!isRecord(value) || !exactKeys(value, ['artifact_id', 'conversation_id', 'created_at', 'source_message_id'])) {
    return false;
  }
  return (
    safeId(value.artifact_id, 128) &&
    safeId(value.conversation_id) &&
    safeId(value.source_message_id) &&
    Number.isSafeInteger(value.created_at) &&
    Number(value.created_at) >= 0
  );
}

function validateAttestationRequest(value: unknown): TypedUIProvenanceAttestationRequest {
  if (!isRecord(value) || !exactKeys(value, ['version', 'envelope', 'artifact'])) {
    throw new Error('attestation.invalid_shape');
  }
  if (value.version !== TYPED_UI_PROVENANCE_ATTESTATION_VERSION) throw new Error('attestation.version');
  const envelope = validateTypedUIEnvelope(value.envelope);
  if (!envelope.ok) throw new Error('attestation.envelope_invalid');
  if (!validateArtifactRef(value.artifact)) throw new Error('attestation.artifact_invalid');
  return {
    version: TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
    envelope: envelope.value,
    artifact: value.artifact,
  };
}

function validateProviderCompletionInput(value: unknown): value is MainOwnedTypedUIProviderCompletionInput {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'version',
      'session_id',
      'provider',
      'model',
      'request_id',
      'route_receipt',
      'seat_id',
      'seat_context_revision',
      'completed_at',
    ])
  ) {
    return false;
  }
  if (
    value.version !== TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION ||
    !safeId(value.session_id) ||
    !boundedString(value.provider) ||
    !boundedString(value.model) ||
    !boundedString(value.request_id) ||
    !safeId(value.seat_id) ||
    !validRevision(value.seat_context_revision) ||
    !isRecord(value.route_receipt) ||
    !exactKeys(value.route_receipt, ['receipt_id', 'route', 'status']) ||
    !safeId(value.route_receipt.receipt_id) ||
    !boundedString(value.route_receipt.route, 128) ||
    value.route_receipt.status !== 'completed' ||
    typeof value.completed_at !== 'string' ||
    Number.isNaN(Date.parse(value.completed_at))
  ) {
    return false;
  }
  return true;
}

function validateProviderCompletionRecord(value: unknown): value is PersistedTypedUIProviderCompletionReceipt {
  if (!isRecord(value) || Object.keys(value).some((key) => !PROVIDER_COMPLETION_RECORD_KEYS.has(key))) return false;
  return (
    value.version === TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION &&
    typeof value.completion_receipt_id === 'string' &&
    PROVIDER_COMPLETION_RECEIPT_ID.test(value.completion_receipt_id) &&
    typeof value.session_id_sha256 === 'string' &&
    SHA256.test(value.session_id_sha256) &&
    typeof value.provider_sha256 === 'string' &&
    SHA256.test(value.provider_sha256) &&
    typeof value.model_sha256 === 'string' &&
    SHA256.test(value.model_sha256) &&
    typeof value.request_id_sha256 === 'string' &&
    SHA256.test(value.request_id_sha256) &&
    typeof value.route_receipt_sha256 === 'string' &&
    SHA256.test(value.route_receipt_sha256) &&
    typeof value.seat_id_sha256 === 'string' &&
    SHA256.test(value.seat_id_sha256) &&
    validRevision(value.seat_context_revision) &&
    value.status === 'completed' &&
    typeof value.completed_at === 'string' &&
    !Number.isNaN(Date.parse(value.completed_at)) &&
    typeof value.recorded_at === 'string' &&
    !Number.isNaN(Date.parse(value.recorded_at))
  );
}

function readProviderCompletionReceipts(filePath: string): PersistedTypedUIProviderCompletionReceipt[] {
  return readRecentJsonLines(filePath).map((value) => {
    if (!validateProviderCompletionRecord(value)) throw new Error('attestation.provider_completion_ledger_corrupt');
    return value;
  });
}

function validateGenerationInput(value: unknown): value is TrustedTypedUIGenerationReceiptInput {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'version',
      'completed_route_receipt_id',
      'artifact_id',
      'conversation_id',
      'source_message_id',
      'created_at',
      'content_sha256',
    ])
  ) {
    return false;
  }
  return (
    value.version === TYPED_UI_GENERATION_RECEIPT_VERSION &&
    typeof value.completed_route_receipt_id === 'string' &&
    PROVIDER_COMPLETION_RECEIPT_ID.test(value.completed_route_receipt_id) &&
    safeId(value.artifact_id, 128) &&
    safeId(value.conversation_id) &&
    safeId(value.source_message_id) &&
    Number.isSafeInteger(value.created_at) &&
    Number(value.created_at) >= 0 &&
    typeof value.content_sha256 === 'string' &&
    SHA256.test(value.content_sha256)
  );
}

function validateGenerationRecord(value: unknown): value is PersistedTypedUIGenerationReceipt {
  if (!isRecord(value) || Object.keys(value).some((key) => !GENERATION_RECORD_KEYS.has(key))) return false;
  return (
    value.version === TYPED_UI_GENERATION_RECEIPT_VERSION &&
    typeof value.receipt_id === 'string' &&
    GENERATION_RECEIPT_ID.test(value.receipt_id) &&
    typeof value.completed_route_receipt_id === 'string' &&
    PROVIDER_COMPLETION_RECEIPT_ID.test(value.completed_route_receipt_id) &&
    safeId(value.artifact_id, 128) &&
    safeId(value.conversation_id) &&
    safeId(value.source_message_id) &&
    Number.isSafeInteger(value.created_at) &&
    Number(value.created_at) >= 0 &&
    typeof value.content_sha256 === 'string' &&
    SHA256.test(value.content_sha256) &&
    typeof value.provider_sha256 === 'string' &&
    SHA256.test(value.provider_sha256) &&
    typeof value.model_sha256 === 'string' &&
    SHA256.test(value.model_sha256) &&
    typeof value.request_id_sha256 === 'string' &&
    SHA256.test(value.request_id_sha256) &&
    typeof value.route_receipt_sha256 === 'string' &&
    SHA256.test(value.route_receipt_sha256) &&
    typeof value.seat_id_sha256 === 'string' &&
    SHA256.test(value.seat_id_sha256) &&
    validRevision(value.seat_context_revision) &&
    value.status === 'completed' &&
    typeof value.recorded_at === 'string' &&
    !Number.isNaN(Date.parse(value.recorded_at))
  );
}

function readGenerationReceipts(filePath: string): PersistedTypedUIGenerationReceipt[] {
  return readRecentJsonLines(filePath).map((value) => {
    if (!validateGenerationRecord(value)) throw new Error('attestation.generation_ledger_corrupt');
    return value;
  });
}

function validateAttestationRecord(value: unknown): value is TypedUIProvenanceAttestation {
  if (!isRecord(value) || Object.keys(value).some((key) => !ATTESTATION_RECORD_KEYS.has(key))) return false;
  return (
    value.version === TYPED_UI_PROVENANCE_ATTESTATION_VERSION &&
    typeof value.attestation_id === 'string' &&
    ATTESTATION_ID.test(value.attestation_id) &&
    safeId(value.artifact_id, 128) &&
    safeId(value.conversation_id) &&
    typeof value.content_sha256 === 'string' &&
    SHA256.test(value.content_sha256) &&
    typeof value.identity_sha256 === 'string' &&
    SHA256.test(value.identity_sha256) &&
    typeof value.request_id_sha256 === 'string' &&
    SHA256.test(value.request_id_sha256) &&
    typeof value.receipt_sha256 === 'string' &&
    SHA256.test(value.receipt_sha256) &&
    validRevision(value.seat_context_revision) &&
    (value.status === 'verified' || value.status === 'rejected') &&
    (value.reason === undefined || boundedString(value.reason, 200)) &&
    typeof value.recorded_at === 'string' &&
    !Number.isNaN(Date.parse(value.recorded_at))
  );
}

function readAttestations(filePath: string): TypedUIProvenanceAttestation[] {
  return readRecentJsonLines(filePath).map((value) => {
    if (!validateAttestationRecord(value)) throw new Error('attestation.ledger_corrupt');
    return value;
  });
}

/** Main-only provider terminal seam. Never expose this over renderer IPC. */
export function appendMainOwnedTypedUIProviderCompletionReceipt(
  completionLedgerPath: string,
  value: unknown,
  options: { now?: () => Date } = {}
): PersistedTypedUIProviderCompletionReceipt {
  if (!validateProviderCompletionInput(value)) throw new Error('attestation.provider_completion_invalid');
  const routeReceiptSha256 = hashJson(value.route_receipt);
  const completionReceiptId = `tuipc_${sha256(
    [
      value.seat_id,
      String(value.seat_context_revision),
      value.session_id,
      value.provider,
      value.model,
      value.request_id,
      routeReceiptSha256,
      value.completed_at,
    ].join('\u0000')
  )}`;
  const existing = readProviderCompletionReceipts(completionLedgerPath).find(
    (record) => record.completion_receipt_id === completionReceiptId
  );
  if (existing) return existing;
  const record: PersistedTypedUIProviderCompletionReceipt = {
    version: TYPED_UI_PROVIDER_COMPLETION_RECEIPT_VERSION,
    completion_receipt_id: completionReceiptId,
    session_id_sha256: sha256(value.session_id),
    provider_sha256: sha256(value.provider),
    model_sha256: sha256(value.model),
    request_id_sha256: sha256(value.request_id),
    route_receipt_sha256: routeReceiptSha256,
    seat_id_sha256: sha256(value.seat_id),
    seat_context_revision: value.seat_context_revision,
    status: 'completed',
    completed_at: value.completed_at,
    recorded_at: (options.now || (() => new Date()))().toISOString(),
  };
  appendPrivateJsonLine(completionLedgerPath, record);
  return record;
}

/**
 * Durable-artifact join seam. It accepts only an opaque completion ID and
 * resolves all route/provider/model evidence from Main's private ledger.
 */
export function appendTrustedTypedUIGenerationReceipt(
  generationLedgerPath: string,
  completionLedgerPath: string,
  value: unknown,
  options: { now?: () => Date } = {}
): PersistedTypedUIGenerationReceipt {
  if (!validateGenerationInput(value)) throw new Error('attestation.generation_receipt_invalid');
  const completion = readProviderCompletionReceipts(completionLedgerPath).find(
    (record) => record.completion_receipt_id === value.completed_route_receipt_id
  );
  if (!completion) throw new Error('attestation.provider_completion_missing');
  const receiptId = `tuigr_${sha256(
    [
      completion.completion_receipt_id,
      value.conversation_id,
      value.artifact_id,
      value.source_message_id,
      value.content_sha256,
    ].join('\u0000')
  )}`;
  const generationReceipts = readGenerationReceipts(generationLedgerPath);
  const existing = generationReceipts.find((record) => record.receipt_id === receiptId);
  if (existing) return existing;
  if (generationReceipts.some((record) => record.completed_route_receipt_id === completion.completion_receipt_id)) {
    throw new Error('attestation.provider_completion_consumed');
  }
  if (
    generationReceipts.some(
      (record) => record.artifact_id === value.artifact_id && record.conversation_id === value.conversation_id
    )
  ) {
    throw new Error('attestation.generation_receipt_conflict');
  }
  const record: PersistedTypedUIGenerationReceipt = {
    version: TYPED_UI_GENERATION_RECEIPT_VERSION,
    receipt_id: receiptId,
    completed_route_receipt_id: completion.completion_receipt_id,
    artifact_id: value.artifact_id,
    conversation_id: value.conversation_id,
    source_message_id: value.source_message_id,
    created_at: value.created_at,
    content_sha256: value.content_sha256,
    provider_sha256: completion.provider_sha256,
    model_sha256: completion.model_sha256,
    request_id_sha256: completion.request_id_sha256,
    route_receipt_sha256: completion.route_receipt_sha256,
    seat_id_sha256: completion.seat_id_sha256,
    seat_context_revision: completion.seat_context_revision,
    status: 'completed',
    recorded_at: (options.now || (() => new Date()))().toISOString(),
  };
  appendPrivateJsonLine(generationLedgerPath, record);
  return record;
}

function generationMismatchReason(
  request: TypedUIProvenanceAttestationRequest,
  record: PersistedTypedUIGenerationReceipt | undefined,
  context: AttestationContext
): string | undefined {
  if (!record) return 'trusted_generation_receipt_missing';
  const { artifact, envelope } = request;
  if (record.provider_sha256 !== sha256(envelope.provenance.provider)) return 'provider_mismatch';
  if (record.model_sha256 !== sha256(envelope.provenance.model)) return 'model_mismatch';
  if (record.request_id_sha256 !== sha256(envelope.provenance.request_id)) return 'request_mismatch';
  if (record.content_sha256 !== hashTypedUIEnvelope(envelope)) return 'content_mismatch';
  if (record.seat_id_sha256 !== sha256(context.activeSeatId)) return 'seat_mismatch';
  if (record.seat_context_revision !== context.seatContextRevision) return 'seat_revision_mismatch';
  if (record.created_at !== artifact.created_at) return 'artifact_time_mismatch';
  if (record.source_message_id !== artifact.source_message_id) return 'source_message_mismatch';
  if (envelope.provenance.source_message_id !== artifact.source_message_id) return 'source_message_mismatch';
  const generatedAt = Date.parse(envelope.provenance.generated_at);
  if (!Number.isFinite(generatedAt) || Math.abs(generatedAt - artifact.created_at) > MAX_GENERATED_AT_DRIFT_MS) {
    return 'generated_time_mismatch';
  }
  return undefined;
}

export function appendTypedUIProvenanceAttestation(
  auditPath: string,
  generationLedgerPath: string,
  value: unknown,
  context: AttestationContext,
  options: { now?: () => Date } = {}
): TypedUIProvenanceAttestation {
  if (!safeId(context.activeSeatId) || !validRevision(context.seatContextRevision)) {
    throw new Error('attestation.seat_context_invalid');
  }
  const request = validateAttestationRequest(value);
  const contentSha256 = hashTypedUIEnvelope(request.envelope);
  const generationRecord = readGenerationReceipts(generationLedgerPath).find(
    (record) =>
      record.artifact_id === request.artifact.artifact_id && record.conversation_id === request.artifact.conversation_id
  );
  const reason = generationMismatchReason(request, generationRecord, context);
  const receiptSha256 = generationRecord?.route_receipt_sha256 ?? EMPTY_SHA256;
  const identitySha256 = sha256(`${request.envelope.provenance.provider}\u0000${request.envelope.provenance.model}`);
  const requestIdSha256 = sha256(request.envelope.provenance.request_id);
  const attestationId = `tuia_${sha256(
    [
      context.activeSeatId,
      String(context.seatContextRevision),
      request.artifact.conversation_id,
      request.artifact.artifact_id,
      contentSha256,
      identitySha256,
      requestIdSha256,
      receiptSha256,
      reason || 'verified',
    ].join('\u0000')
  )}`;
  const existing = readAttestations(auditPath).find((record) => record.attestation_id === attestationId);
  if (existing) return existing;
  const record: TypedUIProvenanceAttestation = {
    version: TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
    attestation_id: attestationId,
    artifact_id: request.artifact.artifact_id,
    conversation_id: request.artifact.conversation_id,
    content_sha256: contentSha256,
    identity_sha256: identitySha256,
    request_id_sha256: requestIdSha256,
    receipt_sha256: receiptSha256,
    seat_context_revision: context.seatContextRevision,
    status: reason ? 'rejected' : 'verified',
    ...(reason ? { reason } : {}),
    recorded_at: (options.now || (() => new Date()))().toISOString(),
  };
  appendPrivateJsonLine(auditPath, record);
  return record;
}

export function requireVerifiedTypedUIProvenanceAttestation(
  auditPath: string,
  input: {
    attestationId: string;
    artifactId: string;
    conversationId: string;
    requestId: string;
    contentSha256: string;
    activeSeatId: string;
    seatContextRevision: number;
  }
): TypedUIProvenanceAttestation {
  if (!ATTESTATION_ID.test(input.attestationId)) throw new Error('attestation.id_invalid');
  if (!SHA256.test(input.contentSha256)) throw new Error('attestation.content_hash_invalid');
  if (!safeId(input.activeSeatId) || !validRevision(input.seatContextRevision)) {
    throw new Error('attestation.seat_context_invalid');
  }
  const record = readAttestations(auditPath).find((candidate) => candidate.attestation_id === input.attestationId);
  if (!record) throw new Error('attestation.not_found');
  if (record.status !== 'verified') throw new Error('attestation.not_verified');
  if (record.artifact_id !== input.artifactId || record.conversation_id !== input.conversationId) {
    throw new Error('attestation.context_mismatch');
  }
  if (record.content_sha256 !== input.contentSha256) throw new Error('attestation.content_mismatch');
  if (record.request_id_sha256 !== sha256(input.requestId)) throw new Error('attestation.request_mismatch');
  if (record.seat_context_revision !== input.seatContextRevision) throw new Error('attestation.seat_revision_mismatch');

  const expectedId = `tuia_${sha256(
    [
      input.activeSeatId,
      String(input.seatContextRevision),
      record.conversation_id,
      record.artifact_id,
      record.content_sha256,
      record.identity_sha256,
      record.request_id_sha256,
      record.receipt_sha256,
      'verified',
    ].join('\u0000')
  )}`;
  if (record.attestation_id !== expectedId) throw new Error('attestation.integrity_mismatch');
  return record;
}
