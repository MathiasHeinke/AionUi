/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICommandEveGateDecision } from '@/common/adapter/ipcBridge';

export const TYPED_UI_SCHEMA_VERSION = 'command-eve.typed-ui/v1' as const;
export const TYPED_UI_CATALOG_VERSION = 'command-eve.typed-ui.catalog/v1' as const;
export const TYPED_UI_MIME_TYPE = 'application/vnd.command-eve.typed-ui+json' as const;

export type TypedUIJsonPrimitive = string | number | boolean | null;
export type TypedUIJsonValue = TypedUIJsonPrimitive | TypedUIJsonValue[] | { [key: string]: TypedUIJsonValue };

export type TypedUIActionType =
  | 'reply_with_state'
  | 'open_artifact'
  | 'open_url'
  | 'select_option'
  | 'request_approval';

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
  source_message_id?: string;
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
  version: 'command-eve.typed-ui-action-receipt/v1';
  receipt_id?: string;
  intent_receipt_id?: string;
  request_id: string;
  source_message_id?: string;
  action_id: string;
  action_type: TypedUIActionType;
  status: 'authorized' | 'completed' | 'blocked' | 'failed' | 'approval_recorded';
  decided_at: string;
  authority: ICommandEveGateDecision;
  reason?: string;
}

export type TypedUIStreamState =
  | { status: 'partial'; bytes: number }
  | { status: 'ready'; bytes: number; value: TypedUIEnvelope }
  | { status: 'invalid'; bytes: number; issues: TypedUIValidationIssue[] };
