/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  bindTypedUIEnvelopeToArtifact,
  TYPED_UI_CATALOG_VERSION,
  TYPED_UI_MIME_TYPE,
  TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
  TYPED_UI_PUBLISH_TOOL_NAME,
  TYPED_UI_SCHEMA_VERSION,
  typedUIToolCallIdFromArtifactId,
  validateTypedUIEnvelope,
  type TypedUIProvenanceAttestation,
  type TypedUIProvenanceAttestationRequest,
} from '@/common/typedUI';
import type { TMessage } from '@/common/chat/chatLib';
import {
  appendTrustedTypedUIGenerationReceipt,
  appendTypedUIProvenanceAttestation,
  hasMatchingTrustedTypedUIGenerationReceipt,
  hashTypedUIEnvelope,
  resolveMainOwnedTypedUIProviderCompletionReceipt,
  TYPED_UI_GENERATION_RECEIPT_VERSION,
} from './typedUIProvenanceAttestationCore';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const MAX_COMPLETION_TO_MESSAGE_DRIFT_MS = 24 * 60 * 60 * 1000;
const RESULT_KEYS = new Set(['ok', 'artifact_type', 'mime_type', 'schema_version', 'catalog_version', 'content']);
const ACP_TYPED_UI_TOOL_NAMES = new Set(['eve_typed_ui_publish', 'mcp__aionui_eve_artifacts__eve_typed_ui_publish']);
const ACP_RESULT_KEYS = new Set([...RESULT_KEYS, 'status', 'tool_name']);
const MAX_DURABLE_RESULT_BYTES = 512 * 1024;

type RecordValue = Record<string, unknown>;

export type TypedUIArtifactAttestationPaths = {
  attestationAuditPath: string;
  generationLedgerPath: string;
  providerCompletionLedgerPath: string;
};

export type TypedUIArtifactAttestationContext = {
  activeSeatId: string;
  seatContextRevision: number;
};

export type TypedUIArtifactAttestationDeps = {
  readMessage: (conversationId: string, sourceMessageId: string) => Promise<TMessage>;
};

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeId(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && SAFE_ID.test(value);
}

function parseRequest(value: unknown): TypedUIProvenanceAttestationRequest {
  if (!isRecord(value) || Object.keys(value).some((key) => !['version', 'envelope', 'artifact'].includes(key))) {
    throw new Error('attestation.invalid_shape');
  }
  if (value.version !== TYPED_UI_PROVENANCE_ATTESTATION_VERSION || !isRecord(value.artifact)) {
    throw new Error('attestation.version');
  }
  if (
    Object.keys(value.artifact).some(
      (key) => !['artifact_id', 'conversation_id', 'source_message_id', 'created_at'].includes(key)
    ) ||
    !safeId(value.artifact.artifact_id, 128) ||
    !safeId(value.artifact.conversation_id) ||
    !safeId(value.artifact.source_message_id) ||
    !Number.isSafeInteger(value.artifact.created_at) ||
    Number(value.artifact.created_at) < 0
  ) {
    throw new Error('attestation.artifact_invalid');
  }
  const envelope = validateTypedUIEnvelope(value.envelope);
  if (!envelope.ok) throw new Error('attestation.envelope_invalid');
  const artifact = value.artifact;
  return {
    version: TYPED_UI_PROVENANCE_ATTESTATION_VERSION,
    envelope: envelope.value,
    artifact: {
      artifact_id: artifact.artifact_id as string,
      conversation_id: artifact.conversation_id as string,
      source_message_id: artifact.source_message_id as string,
      created_at: artifact.created_at as number,
    },
  };
}

function parseResultDisplay(value: unknown): RecordValue | undefined {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (!isRecord(value)) return undefined;
  if (Array.isArray(value.content) && value.content.length === 1) {
    const item = value.content[0];
    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') return parseResultDisplay(item.text);
  }
  return value;
}

function parseTypedUIPublishResult(value: unknown, acceptAcpCompletedStatus = false): RecordValue {
  const payload = parseResultDisplay(value);
  const allowedKeys = acceptAcpCompletedStatus ? ACP_RESULT_KEYS : RESULT_KEYS;
  if (
    !payload ||
    Object.keys(payload).some((key) => !allowedKeys.has(key)) ||
    (acceptAcpCompletedStatus &&
      ((payload.status !== undefined && payload.status !== 'completed') ||
        typeof payload.tool_name !== 'string' ||
        !ACP_TYPED_UI_TOOL_NAMES.has(payload.tool_name)))
  ) {
    throw new Error('attestation.durable_result_invalid');
  }
  if (
    payload.ok !== true ||
    payload.artifact_type !== 'file' ||
    payload.mime_type !== TYPED_UI_MIME_TYPE ||
    payload.schema_version !== TYPED_UI_SCHEMA_VERSION ||
    payload.catalog_version !== TYPED_UI_CATALOG_VERSION ||
    typeof payload.content !== 'string' ||
    Buffer.byteLength(payload.content, 'utf8') > MAX_DURABLE_RESULT_BYTES
  ) {
    throw new Error('attestation.durable_result_invalid');
  }
  return {
    ok: true,
    artifact_type: 'file',
    mime_type: TYPED_UI_MIME_TYPE,
    schema_version: TYPED_UI_SCHEMA_VERSION,
    catalog_version: TYPED_UI_CATALOG_VERSION,
    content: payload.content,
  };
}

function readDurablePublishResult(message: TMessage, sourceMessageId: string, toolCallId: string): RecordValue {
  const messageId = message.msg_id || message.id;
  if (
    message.type !== 'tool_group' ||
    message.conversation_id.length === 0 ||
    messageId !== sourceMessageId ||
    !Array.isArray(message.content)
  ) {
    throw new Error('attestation.durable_message_mismatch');
  }
  const matches = message.content.filter(
    (item) => item.call_id === toolCallId && item.name === TYPED_UI_PUBLISH_TOOL_NAME && item.status === 'Success'
  );
  if (matches.length !== 1) throw new Error('attestation.durable_tool_call_mismatch');
  return parseTypedUIPublishResult(matches[0].result_display);
}

function readDurableAcpPublishResult(message: TMessage, sourceMessageId: string, toolCallId: string): RecordValue {
  const messageId = message.msg_id || message.id;
  // AionCore persists ACP events as snake_case JSON. Its renderer-facing
  // TypeScript projection intentionally does not model raw_output, so this
  // Main-owned boundary treats it as unknown and validates every field.
  const content = message.type === 'acp_tool_call' ? (message.content as unknown) : undefined;
  const update = isRecord(content) && isRecord(content.update) ? content.update : undefined;
  if (
    message.type !== 'acp_tool_call' ||
    message.conversation_id.length === 0 ||
    messageId !== sourceMessageId ||
    !update ||
    update.session_update !== 'tool_call_update' ||
    update.tool_call_id !== toolCallId ||
    update.status !== 'completed'
  ) {
    throw new Error('attestation.durable_message_mismatch');
  }
  return parseTypedUIPublishResult(update.raw_output, true);
}

export async function attestDurableTypedUIArtifact(
  paths: TypedUIArtifactAttestationPaths,
  value: unknown,
  context: TypedUIArtifactAttestationContext,
  deps: TypedUIArtifactAttestationDeps
): Promise<TypedUIProvenanceAttestation> {
  const request = parseRequest(value);
  if (hasMatchingTrustedTypedUIGenerationReceipt(paths.generationLedgerPath, request, context)) {
    return appendTypedUIProvenanceAttestation(paths.attestationAuditPath, paths.generationLedgerPath, request, context);
  }
  const toolCallId = typedUIToolCallIdFromArtifactId(request.artifact.artifact_id);
  if (!toolCallId) throw new Error('attestation.artifact_tool_call_invalid');
  const message = await deps.readMessage(request.artifact.conversation_id, request.artifact.source_message_id);
  if (
    message.conversation_id !== request.artifact.conversation_id ||
    message.created_at !== request.artifact.created_at
  ) {
    throw new Error('attestation.durable_message_mismatch');
  }
  const result =
    message.type === 'acp_tool_call'
      ? readDurableAcpPublishResult(message, request.artifact.source_message_id, toolCallId)
      : readDurablePublishResult(message, request.artifact.source_message_id, toolCallId);
  let rawValue: unknown;
  try {
    rawValue = JSON.parse(result.content as string) as unknown;
  } catch {
    throw new Error('attestation.durable_content_invalid');
  }
  const rawEnvelope = validateTypedUIEnvelope(rawValue);
  if (!rawEnvelope.ok) throw new Error('attestation.durable_content_invalid');
  const rawContentSha256 = hashTypedUIEnvelope(rawEnvelope.value);
  const boundEnvelope = bindTypedUIEnvelopeToArtifact(rawEnvelope.value, request.artifact);
  if (hashTypedUIEnvelope(boundEnvelope) !== hashTypedUIEnvelope(request.envelope)) {
    throw new Error('attestation.durable_content_mismatch');
  }
  const completion = resolveMainOwnedTypedUIProviderCompletionReceipt(paths.providerCompletionLedgerPath, {
    toolCallId,
    rawContentSha256,
    activeSeatId: context.activeSeatId,
    seatContextRevision: context.seatContextRevision,
  });
  if (completion) {
    const completedAt = Date.parse(completion.completed_at);
    if (
      !Number.isFinite(completedAt) ||
      Math.abs(completedAt - request.artifact.created_at) > MAX_COMPLETION_TO_MESSAGE_DRIFT_MS
    ) {
      throw new Error('attestation.provider_completion_time_mismatch');
    }
    appendTrustedTypedUIGenerationReceipt(paths.generationLedgerPath, paths.providerCompletionLedgerPath, {
      version: TYPED_UI_GENERATION_RECEIPT_VERSION,
      completed_route_receipt_id: completion.completion_receipt_id,
      artifact_id: request.artifact.artifact_id,
      conversation_id: request.artifact.conversation_id,
      source_message_id: request.artifact.source_message_id,
      created_at: request.artifact.created_at,
      content_sha256: hashTypedUIEnvelope(request.envelope),
      tool_call_id: toolCallId,
      raw_content_sha256: rawContentSha256,
    });
  }
  return appendTypedUIProvenanceAttestation(paths.attestationAuditPath, paths.generationLedgerPath, request, context);
}
