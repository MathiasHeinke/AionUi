/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IConversationArtifactBase } from '@/common/adapter/ipcBridge';
import { parseHermesMediaDirectives } from '@/common/config/hermesMediaDirectiveCore';
import {
  COMMAND_EVE_PREPARED_CONTEXT_END,
  COMMAND_EVE_PREPARED_CONTEXT_START,
} from '@/common/config/evePreparedContextCore';
import { isSafeOpaqueRecordId } from '@/common/config/eveOpaqueTokenCore';

export const COMMAND_EVE_OFFICE_LINEAGE_VERSION = 1 as const;
export const COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY = 'office-studio' as const;

export type CommandEveOfficeArtifactMode = 'word' | 'excel';
export type CommandEveOfficeArtifactAction = 'create' | 'edit';
export type CommandEveOfficeArtifactOriginAction = CommandEveOfficeArtifactAction | 'source';

export type CommandEveOfficeConversationArtifactPayload = {
  artifact_type: 'file';
  artifact_id: string;
  title: string;
  file_name: string;
  mime_type: string;
  /** Main-authored, workspace-relative immutable copy. Never an absolute renderer path. */
  path: string;
  size: number;
  hash: string;
  managed_office: true;
  office_mode: CommandEveOfficeArtifactMode;
  origin_capability: typeof COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY;
  origin_action: CommandEveOfficeArtifactOriginAction;
  parent_artifact_id: string | null;
  source_sha256: string;
  source_size: number;
  source_fingerprint: string;
  result_sha256: string;
  result_fingerprint: string;
  operation_id: string;
  seat_id: string;
  seat_context_revision: number;
  source_message_id: string | null;
  source_turn_id: string | null;
  source_directive_index: number | null;
  source_tool: 'hermes_media_directive' | 'office_transcript_import' | 'aioncore_artifact_import';
};

export type CommandEveOfficeConversationArtifact = IConversationArtifactBase<
  'file',
  CommandEveOfficeConversationArtifactPayload
>;

export type CommandEveOfficeOperationRecord = {
  version: typeof COMMAND_EVE_OFFICE_LINEAGE_VERSION;
  operation_id: string;
  request_id: string;
  seat_id: string;
  seat_context_revision: number;
  process_id: number;
  process_nonce_sha256: string;
  conversation_id: string;
  action: CommandEveOfficeArtifactAction;
  mode: CommandEveOfficeArtifactMode;
  origin_capability: typeof COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY;
  parent_artifact_id: string | null;
  source_sha256: string | null;
  source_size: number | null;
  source_fingerprint: string | null;
  created_at: number;
};

export type CommandEveOfficeOperationCompletionRecord = {
  version: typeof COMMAND_EVE_OFFICE_LINEAGE_VERSION;
  operation_id: string;
  seat_id: string;
  seat_context_revision: number;
  conversation_id: string;
  artifact_receipts: Array<{
    artifact_id: string;
    payload_sha256: string;
  }>;
  completed_at: number;
};

/**
 * The ONLY reason an operation may be sealed without a result: the Main boot
 * that owned it is provably gone, so the process fence can never authorize it
 * again. Naming the reason keeps "abandoned" from becoming a silent catch-all.
 */
export const COMMAND_EVE_OFFICE_ABANDONMENT_REASON = 'process-boot-gone' as const;

export type CommandEveOfficeOperationAbandonmentRecord = {
  version: typeof COMMAND_EVE_OFFICE_LINEAGE_VERSION;
  operation_id: string;
  seat_id: string;
  seat_context_revision: number;
  conversation_id: string;
  reason: typeof COMMAND_EVE_OFFICE_ABANDONMENT_REASON;
  abandoned_at: number;
};

export type CommandEveOfficeResultCandidate = {
  operationId: string;
  messageId: string;
  turnId: string;
  directiveIndex: number;
  source: string;
  title: string;
};

const SHA256 = /^[a-f0-9]{64}$/;
const OFFICE_OPERATION_ID = /^officeop_[a-f0-9]{64}$/;
const FINISHED_MESSAGE_STATUSES = new Set(['finish', 'finished', 'completed', 'complete', 'done']);
const ARTIFACT_KEYS = ['id', 'conversation_id', 'kind', 'status', 'payload', 'created_at', 'updated_at'] as const;
const OFFICE_PAYLOAD_KEYS = [
  'artifact_type',
  'artifact_id',
  'title',
  'file_name',
  'mime_type',
  'path',
  'size',
  'hash',
  'managed_office',
  'office_mode',
  'origin_capability',
  'origin_action',
  'parent_artifact_id',
  'source_sha256',
  'source_size',
  'source_fingerprint',
  'result_sha256',
  'result_fingerprint',
  'operation_id',
  'seat_id',
  'seat_context_revision',
  'source_message_id',
  'source_turn_id',
  'source_directive_index',
  'source_tool',
] as const;
const OPERATION_KEYS = [
  'version',
  'operation_id',
  'request_id',
  'seat_id',
  'seat_context_revision',
  'process_id',
  'process_nonce_sha256',
  'conversation_id',
  'action',
  'mode',
  'origin_capability',
  'parent_artifact_id',
  'source_sha256',
  'source_size',
  'source_fingerprint',
  'created_at',
] as const;
const OPERATION_COMPLETION_KEYS = [
  'version',
  'operation_id',
  'seat_id',
  'seat_context_revision',
  'conversation_id',
  'artifact_receipts',
  'completed_at',
] as const;
const OPERATION_COMPLETION_ARTIFACT_KEYS = ['artifact_id', 'payload_sha256'] as const;
const OPERATION_ABANDONMENT_KEYS = [
  'version',
  'operation_id',
  'seat_id',
  'seat_context_revision',
  'conversation_id',
  'reason',
  'abandoned_at',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

export function isCommandEveOfficeArtifactMode(value: unknown): value is CommandEveOfficeArtifactMode {
  return value === 'word' || value === 'excel';
}

export function isCommandEveOfficeOperationId(value: unknown): value is string {
  return typeof value === 'string' && OFFICE_OPERATION_ID.test(value);
}

export function commandEveOfficeExtension(mode: CommandEveOfficeArtifactMode): '.docx' | '.xlsx' {
  return mode === 'word' ? '.docx' : '.xlsx';
}

export function commandEveOfficeMimeType(
  mode: CommandEveOfficeArtifactMode
):
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' {
  return mode === 'word'
    ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}

export function commandEveOfficeFingerprint(mode: CommandEveOfficeArtifactMode, sha256: string, size: number): string {
  return 'office-v1:' + mode + ':' + String(size) + ':' + sha256;
}

export function buildCommandEveOfficeOperationMarker(operationId: string): string {
  if (!isCommandEveOfficeOperationId(operationId)) throw new Error('invalid Office operation id');
  return '<command-eve-office-operation version="1" id="' + operationId + '" />';
}

function preparedContextBodies(value: string): string[] {
  const bodies: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf(COMMAND_EVE_PREPARED_CONTEXT_START, cursor);
    if (start < 0) break;
    const bodyStart = start + COMMAND_EVE_PREPARED_CONTEXT_START.length;
    const end = value.indexOf(COMMAND_EVE_PREPARED_CONTEXT_END, bodyStart);
    if (end < 0) break;
    bodies.push(value.slice(bodyStart, end));
    cursor = end + COMMAND_EVE_PREPARED_CONTEXT_END.length;
  }
  return bodies;
}

function operationIdsFromPreparedContext(value: string): string[] {
  const ids = new Set<string>();
  const marker = /<command-eve-office-operation version="1" id="(officeop_[a-f0-9]{64})" \/>/g;
  for (const body of preparedContextBodies(value)) {
    for (const match of body.matchAll(marker)) ids.add(match[1]);
  }
  return [...ids];
}

function messageText(message: Record<string, unknown>): string | null {
  let content = message.content;
  if (typeof content === 'string') {
    const rawContent = content;
    try {
      const parsed = JSON.parse(content) as unknown;
      if (isRecord(parsed)) content = parsed;
      else return rawContent;
    } catch {
      return rawContent;
    }
  }
  return isRecord(content) && typeof content.content === 'string' ? content.content : null;
}

function transcriptItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.messages)) return value.messages;
  return isRecord(value.data) && Array.isArray(value.data.items) ? value.data.items : [];
}

function completedMessage(message: Record<string, unknown>): boolean {
  return typeof message.status === 'string' && FINISHED_MESSAGE_STATUSES.has(message.status.trim().toLowerCase());
}

/**
 * Extract Office result candidates only from persisted assistant MEDIA lines
 * belonging to a user turn that carries a Main-issued operation marker.
 */
export function extractCommandEveOfficeResultCandidates(
  transcript: unknown,
  conversationId: string
): CommandEveOfficeResultCandidate[] {
  let active:
    | {
        operationId: string;
        turnId: string | null;
      }
    | undefined;
  const candidates = new Map<string, CommandEveOfficeResultCandidate>();

  for (const item of transcriptItems(transcript)) {
    if (!isRecord(item) || item.hidden === true || item.type !== 'text') continue;
    if (item.conversation_id !== conversationId) continue;
    const position = item.position;
    const text = messageText(item);
    if (position === 'right') {
      active = undefined;
      if (!text) continue;
      const operationIds = operationIdsFromPreparedContext(text);
      if (operationIds.length !== 1) continue;
      const turnId = typeof item.turn_id === 'string' && isSafeOpaqueRecordId(item.turn_id) ? item.turn_id : null;
      if (!turnId) continue;
      active = { operationId: operationIds[0], turnId };
      continue;
    }
    if (position !== 'left' || !active || !text || !completedMessage(item)) continue;

    const messageId = typeof item.id === 'string' && isSafeOpaqueRecordId(item.id) ? item.id : null;
    if (!messageId) continue;
    const messageTurnId = typeof item.turn_id === 'string' && isSafeOpaqueRecordId(item.turn_id) ? item.turn_id : null;
    if (!active.turnId || !messageTurnId || active.turnId !== messageTurnId) continue;
    const turnId = messageTurnId;
    const directives = parseHermesMediaDirectives(text).directives;
    directives.forEach((directive, directiveIndex) => {
      if (directive.artifactType !== 'file') return;
      const key = active!.operationId + ':' + messageId + ':' + String(directiveIndex);
      if (candidates.has(key)) return;
      candidates.set(key, {
        operationId: active!.operationId,
        messageId,
        turnId,
        directiveIndex,
        source: directive.source,
        title: directive.title,
      });
    });
  }
  return [...candidates.values()];
}

function isSafeRelativeArtifactPath(value: unknown, mode: CommandEveOfficeArtifactMode): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    !value.startsWith('.command-eve/conversation-artifacts/') ||
    !value.toLowerCase().endsWith(commandEveOfficeExtension(mode))
  ) {
    return false;
  }
  return !value.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..');
}

function isSafeLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 180 &&
    !value.includes('\0') &&
    !/[\r\n]/.test(value)
  );
}

export function parseCommandEveOfficeConversationArtifact(value: unknown): CommandEveOfficeConversationArtifact {
  if (!isRecord(value) || !hasExactKeys(value, ARTIFACT_KEYS)) throw new Error('invalid Office artifact');
  const payload = value.payload;
  if (!isRecord(payload) || !hasExactKeys(payload, OFFICE_PAYLOAD_KEYS)) {
    throw new Error('invalid Office artifact payload');
  }
  const mode = payload.office_mode;
  const action = payload.origin_action;
  if (
    typeof value.id !== 'string' ||
    !isSafeOpaqueRecordId(value.id) ||
    typeof value.conversation_id !== 'string' ||
    !isSafeOpaqueRecordId(value.conversation_id) ||
    value.kind !== 'file' ||
    value.status !== 'active' ||
    !Number.isSafeInteger(value.created_at) ||
    Number(value.created_at) < 0 ||
    !Number.isSafeInteger(value.updated_at) ||
    Number(value.updated_at) < Number(value.created_at) ||
    payload.artifact_type !== 'file' ||
    payload.artifact_id !== value.id ||
    payload.managed_office !== true ||
    !isCommandEveOfficeArtifactMode(mode) ||
    !['create', 'edit', 'source'].includes(String(action)) ||
    payload.origin_capability !== COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY ||
    !isSafeLabel(payload.title) ||
    !isSafeLabel(payload.file_name) ||
    payload.mime_type !== commandEveOfficeMimeType(mode) ||
    !isSafeRelativeArtifactPath(payload.path, mode) ||
    !Number.isSafeInteger(payload.size) ||
    Number(payload.size) <= 0 ||
    !SHA256.test(String(payload.hash)) ||
    !SHA256.test(String(payload.source_sha256)) ||
    !Number.isSafeInteger(payload.source_size) ||
    Number(payload.source_size) <= 0 ||
    payload.source_fingerprint !==
      commandEveOfficeFingerprint(mode, String(payload.source_sha256), Number(payload.source_size)) ||
    !SHA256.test(String(payload.result_sha256)) ||
    payload.hash !== payload.result_sha256 ||
    payload.result_fingerprint !==
      commandEveOfficeFingerprint(mode, String(payload.result_sha256), Number(payload.size)) ||
    !isCommandEveOfficeOperationId(payload.operation_id) ||
    typeof payload.seat_id !== 'string' ||
    !isSafeOpaqueRecordId(payload.seat_id) ||
    !Number.isSafeInteger(payload.seat_context_revision) ||
    Number(payload.seat_context_revision) < 0 ||
    !['hermes_media_directive', 'office_transcript_import', 'aioncore_artifact_import'].includes(
      String(payload.source_tool)
    )
  ) {
    throw new Error('invalid Office artifact fields');
  }
  const parent = payload.parent_artifact_id;
  if (
    (action === 'edit' && (typeof parent !== 'string' || !isSafeOpaqueRecordId(parent))) ||
    (action !== 'edit' && parent !== null)
  ) {
    throw new Error('invalid Office artifact parent');
  }
  const messageProvenance =
    typeof payload.source_message_id === 'string' &&
    isSafeOpaqueRecordId(payload.source_message_id) &&
    typeof payload.source_turn_id === 'string' &&
    isSafeOpaqueRecordId(payload.source_turn_id) &&
    Number.isSafeInteger(payload.source_directive_index) &&
    Number(payload.source_directive_index) >= 0 &&
    Number(payload.source_directive_index) <= 99;
  const sourceTupleMatchesResult =
    payload.source_sha256 === payload.result_sha256 &&
    payload.source_size === payload.size &&
    payload.source_fingerprint === payload.result_fingerprint;
  if (
    (payload.source_tool === 'aioncore_artifact_import' &&
      (payload.source_message_id !== null ||
        payload.source_turn_id !== null ||
        payload.source_directive_index !== null)) ||
    (payload.source_tool !== 'aioncore_artifact_import' && !messageProvenance) ||
    (action === 'source' && payload.source_tool === 'hermes_media_directive') ||
    (action === 'source' && !sourceTupleMatchesResult) ||
    (action !== 'source' && payload.source_tool !== 'hermes_media_directive')
  ) {
    throw new Error('invalid Office artifact source provenance');
  }
  return value as unknown as CommandEveOfficeConversationArtifact;
}

export function parseCommandEveOfficeOperationRecord(value: unknown): CommandEveOfficeOperationRecord {
  if (!isRecord(value) || !hasExactKeys(value, OPERATION_KEYS)) throw new Error('invalid Office operation');
  const action = value.action;
  if (
    value.version !== COMMAND_EVE_OFFICE_LINEAGE_VERSION ||
    !isCommandEveOfficeOperationId(value.operation_id) ||
    typeof value.request_id !== 'string' ||
    !isSafeOpaqueRecordId(value.request_id) ||
    typeof value.seat_id !== 'string' ||
    !isSafeOpaqueRecordId(value.seat_id) ||
    !Number.isSafeInteger(value.seat_context_revision) ||
    Number(value.seat_context_revision) < 0 ||
    !Number.isSafeInteger(value.process_id) ||
    Number(value.process_id) <= 0 ||
    typeof value.process_nonce_sha256 !== 'string' ||
    !SHA256.test(value.process_nonce_sha256) ||
    typeof value.conversation_id !== 'string' ||
    !isSafeOpaqueRecordId(value.conversation_id) ||
    !['create', 'edit'].includes(String(action)) ||
    !isCommandEveOfficeArtifactMode(value.mode) ||
    value.origin_capability !== COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY ||
    !Number.isSafeInteger(value.created_at) ||
    Number(value.created_at) < 0
  ) {
    throw new Error('invalid Office operation fields');
  }
  const parent = value.parent_artifact_id;
  const sha = value.source_sha256;
  const size = value.source_size;
  const fingerprint = value.source_fingerprint;
  if (action === 'edit') {
    if (
      typeof parent !== 'string' ||
      !isSafeOpaqueRecordId(parent) ||
      typeof sha !== 'string' ||
      !SHA256.test(sha) ||
      !Number.isSafeInteger(size) ||
      Number(size) <= 0 ||
      fingerprint !== commandEveOfficeFingerprint(value.mode, sha, Number(size))
    ) {
      throw new Error('invalid Office edit operation source');
    }
  } else if (parent !== null || sha !== null || size !== null || fingerprint !== null) {
    throw new Error('invalid Office create operation source');
  }
  return value as CommandEveOfficeOperationRecord;
}

export function parseCommandEveOfficeOperationCompletionRecord(
  value: unknown
): CommandEveOfficeOperationCompletionRecord {
  if (!isRecord(value) || !hasExactKeys(value, OPERATION_COMPLETION_KEYS)) {
    throw new Error('invalid Office operation completion');
  }
  const artifactReceipts = value.artifact_receipts;
  if (
    value.version !== COMMAND_EVE_OFFICE_LINEAGE_VERSION ||
    !isCommandEveOfficeOperationId(value.operation_id) ||
    typeof value.seat_id !== 'string' ||
    !isSafeOpaqueRecordId(value.seat_id) ||
    !Number.isSafeInteger(value.seat_context_revision) ||
    Number(value.seat_context_revision) < 0 ||
    typeof value.conversation_id !== 'string' ||
    !isSafeOpaqueRecordId(value.conversation_id) ||
    !Array.isArray(artifactReceipts) ||
    artifactReceipts.length === 0 ||
    artifactReceipts.length > 32 ||
    artifactReceipts.some(
      (receipt) =>
        !isRecord(receipt) ||
        !hasExactKeys(receipt, OPERATION_COMPLETION_ARTIFACT_KEYS) ||
        typeof receipt.artifact_id !== 'string' ||
        !isSafeOpaqueRecordId(receipt.artifact_id) ||
        typeof receipt.payload_sha256 !== 'string' ||
        !SHA256.test(receipt.payload_sha256)
    ) ||
    !Number.isSafeInteger(value.completed_at) ||
    Number(value.completed_at) < 0
  ) {
    throw new Error('invalid Office operation completion fields');
  }
  const parsedReceipts = artifactReceipts as Array<{ artifact_id: string; payload_sha256: string }>;
  if (
    new Set(parsedReceipts.map((receipt) => receipt.artifact_id)).size !== parsedReceipts.length ||
    parsedReceipts.some(
      (receipt, index) => index > 0 && parsedReceipts[index - 1].artifact_id.localeCompare(receipt.artifact_id) >= 0
    )
  ) {
    throw new Error('invalid Office operation completion membership');
  }
  return value as CommandEveOfficeOperationCompletionRecord;
}

export function parseCommandEveOfficeOperationAbandonmentRecord(
  value: unknown
): CommandEveOfficeOperationAbandonmentRecord {
  if (!isRecord(value) || !hasExactKeys(value, OPERATION_ABANDONMENT_KEYS)) {
    throw new Error('invalid Office operation abandonment');
  }
  if (
    value.version !== COMMAND_EVE_OFFICE_LINEAGE_VERSION ||
    !isCommandEveOfficeOperationId(value.operation_id) ||
    typeof value.seat_id !== 'string' ||
    !isSafeOpaqueRecordId(value.seat_id) ||
    !Number.isSafeInteger(value.seat_context_revision) ||
    Number(value.seat_context_revision) < 0 ||
    typeof value.conversation_id !== 'string' ||
    !isSafeOpaqueRecordId(value.conversation_id) ||
    value.reason !== COMMAND_EVE_OFFICE_ABANDONMENT_REASON ||
    !Number.isSafeInteger(value.abandoned_at) ||
    Number(value.abandoned_at) < 0
  ) {
    throw new Error('invalid Office operation abandonment fields');
  }
  return value as CommandEveOfficeOperationAbandonmentRecord;
}
