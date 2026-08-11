/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICommandEveGateDecision } from '@/common/adapter/ipcBridge';

export const TYPED_UI_SCHEMA_VERSION = 'command-eve.typed-ui/v2' as const;
export const TYPED_UI_CATALOG_VERSION = 'command-eve.typed-ui.catalog/v2' as const;
export const TYPED_UI_MIME_TYPE = 'application/vnd.command-eve.typed-ui+json' as const;
export const TYPED_UI_PROVENANCE_ATTESTATION_VERSION = 'command-eve.typed-ui-provenance-attestation/v2' as const;
export const TYPED_UI_ACTION_AUTHORIZATION_VERSION = 'command-eve.typed-ui-action-authorization/v2' as const;
export const TYPED_UI_DURABLE_WORK_VERSION = 'command-eve-durable-work-activity/v1' as const;

export type TypedUIJsonPrimitive = string | number | boolean | null;
export type TypedUIJsonValue = TypedUIJsonPrimitive | TypedUIJsonValue[] | { [key: string]: TypedUIJsonValue };

export type TypedUIActionType =
  | 'reply_with_state'
  | 'open_artifact'
  | 'open_url'
  | 'select_option'
  | 'request_approval'
  | 'goal_control'
  | 'worker_control';

export type TypedUIArtifactKind = 'chat' | 'file' | 'browser' | 'goal' | 'worker';
export type TypedUILifecycleControl = 'pause' | 'resume' | 'cancel';

export type TypedUIComponentName =
  | 'Card'
  | 'Stack'
  | 'Grid'
  | 'Separator'
  | 'Tabs'
  | 'Accordion'
  | 'Collapsible'
  | 'Dialog'
  | 'Drawer'
  | 'Carousel'
  | 'Table'
  | 'Heading'
  | 'Text'
  | 'Image'
  | 'Avatar'
  | 'Badge'
  | 'Alert'
  | 'Progress'
  | 'Skeleton'
  | 'Spinner'
  | 'Tooltip'
  | 'Popover'
  | 'Input'
  | 'Textarea'
  | 'Select'
  | 'Checkbox'
  | 'Radio'
  | 'Switch'
  | 'Slider'
  | 'Button'
  | 'Link'
  | 'DropdownMenu'
  | 'Toggle'
  | 'ToggleGroup'
  | 'ButtonGroup'
  | 'Pagination'
  | 'Metric'
  | 'KeyValue'
  | 'Code'
  | 'Markdown'
  | 'List'
  | 'Timeline'
  | 'Goal'
  | 'WorkerRun'
  | 'DecisionCard';

export interface TypedUIElement {
  type: TypedUIComponentName;
  props: Record<string, TypedUIJsonValue>;
  children: string[];
  on?: Record<string, string>;
}

export interface TypedUIActionDefinition {
  type: TypedUIActionType;
  params: Record<string, TypedUIJsonValue>;
}

export interface TypedUIProvenance {
  provider: string;
  model: string;
  request_id: string;
  generated_at: string;
  source_message_id: string;
}

export interface TypedUIProvenanceArtifactRef {
  artifact_id: string;
  conversation_id: string;
  created_at: number;
  source_message_id: string;
}

export interface TypedUIProvenanceAttestationRequest {
  version: typeof TYPED_UI_PROVENANCE_ATTESTATION_VERSION;
  envelope: TypedUIEnvelope;
  artifact: TypedUIProvenanceArtifactRef;
}

export interface TypedUIProvenanceAttestation {
  version: typeof TYPED_UI_PROVENANCE_ATTESTATION_VERSION;
  attestation_id: string;
  artifact_id: string;
  conversation_id: string;
  source_message_id: string;
  content_sha256: string;
  action_set_sha256: string;
  identity_sha256: string;
  request_id_sha256: string;
  receipt_sha256: string;
  seat_context_revision: number;
  status: 'verified' | 'rejected';
  reason?: string;
  recorded_at: string;
}

export interface TypedUIActionAuthorizeRequest {
  version: typeof TYPED_UI_ACTION_AUTHORIZATION_VERSION;
  phase: 'authorize';
  request_id: string;
  artifact_id: string;
  conversation_id: string;
  attestation_id: string;
  content_sha256: string;
  source_message_id: string;
  action_id: string;
  action_type: TypedUIActionType;
  params: Record<string, TypedUIJsonValue>;
}

export interface TypedUIActionFinalizeRequest {
  version: typeof TYPED_UI_ACTION_AUTHORIZATION_VERSION;
  phase: 'finalize';
  intent_receipt_id: string;
  intent_claim_id: string;
  outcome: 'completed' | 'failed';
  reason?: string;
}

export type TypedUIActionReceiptRequest = TypedUIActionAuthorizeRequest | TypedUIActionFinalizeRequest;

export interface TypedUILifecycleControlRequest {
  version: typeof TYPED_UI_DURABLE_WORK_VERSION;
  conversation_id: string;
  work_item_id: string;
  target_kind: 'goal' | 'worker';
  action: TypedUILifecycleControl;
  expected_revision: number;
  expected_sequence: number;
}

export interface TypedUILifecycleControlResult {
  version: typeof TYPED_UI_DURABLE_WORK_VERSION;
  state: 'accepted' | 'needs_approval' | 'rejected' | 'unavailable';
  receipt_id?: string;
  reason?: string;
}

export interface TypedUIEnvelope {
  schema_version: typeof TYPED_UI_SCHEMA_VERSION;
  catalog_version: typeof TYPED_UI_CATALOG_VERSION;
  root: string;
  elements: Record<string, TypedUIElement>;
  state: Record<string, TypedUIJsonValue>;
  actions: Record<string, TypedUIActionDefinition>;
  provenance: TypedUIProvenance;
}

export interface TypedUIValidationIssue {
  code: string;
  path: string;
  message: string;
}

export type TypedUIValidationResult =
  | { ok: true; value: TypedUIEnvelope }
  | { ok: false; issues: TypedUIValidationIssue[] };

export interface TypedUIActionReceipt {
  version: 'command-eve.typed-ui-action-receipt/v2';
  receipt_id?: string;
  intent_receipt_id?: string;
  intent_claim_id?: string;
  request_id: string;
  artifact_id: string;
  conversation_id: string;
  attestation_id: string;
  content_sha256: string;
  source_message_id: string;
  action_id: string;
  action_type: TypedUIActionType;
  action_params_sha256: string;
  action_binding_sha256: string;
  status: 'authorized' | 'completed' | 'blocked' | 'failed' | 'approval_recorded';
  decided_at: string;
  authority: ICommandEveGateDecision;
  reason?: string;
}

export type TypedUIStreamState =
  | { status: 'partial'; bytes: number }
  | { status: 'ready'; bytes: number; value: TypedUIEnvelope }
  | { status: 'invalid'; bytes: number; issues: TypedUIValidationIssue[] };
