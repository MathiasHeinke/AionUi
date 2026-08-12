/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TypedUIComponentName, TypedUIJsonValue } from './types';

export type TypedUIPropKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'state_path'
  | 'string_array'
  | 'options'
  | 'table_columns'
  | 'table_rows'
  | 'key_value_items'
  | 'timeline_items';

export interface TypedUIPropRule {
  kind: TypedUIPropKind;
  required?: boolean;
  values?: readonly TypedUIJsonValue[];
  minimum?: number;
  maximum?: number;
}

export interface TypedUIComponentDefinition {
  description: string;
  props: Readonly<Record<string, TypedUIPropRule>>;
  events: readonly string[];
  children: boolean;
  eve_native?: true;
}

const string = (required = false): TypedUIPropRule => ({ kind: 'string', required });
const number = (minimum?: number, maximum?: number): TypedUIPropRule => ({ kind: 'number', minimum, maximum });
const boolean = (): TypedUIPropRule => ({ kind: 'boolean' });
const statePath = (required = false): TypedUIPropRule => ({ kind: 'state_path', required });
const oneOf = (...values: readonly TypedUIJsonValue[]): TypedUIPropRule => ({ kind: 'string', values });

export const TYPED_UI_BASE_COMPONENTS = [
  'Card',
  'Stack',
  'Grid',
  'Separator',
  'Tabs',
  'Accordion',
  'Collapsible',
  'Dialog',
  'Drawer',
  'Carousel',
  'Table',
  'Heading',
  'Text',
  'Image',
  'Avatar',
  'Badge',
  'Alert',
  'Progress',
  'Skeleton',
  'Spinner',
  'Tooltip',
  'Popover',
  'Input',
  'Textarea',
  'Select',
  'Checkbox',
  'Radio',
  'Switch',
  'Slider',
  'Button',
  'Link',
  'DropdownMenu',
  'Toggle',
  'ToggleGroup',
  'ButtonGroup',
  'Pagination',
  'Metric',
  'KeyValue',
  'Code',
  'Markdown',
  'List',
  'Timeline',
] as const satisfies readonly TypedUIComponentName[];

export const TYPED_UI_EVE_COMPONENTS = [
  'Goal',
  'WorkerRun',
  'DecisionCard',
] as const satisfies readonly TypedUIComponentName[];

export const TYPED_UI_COMPONENTS = [...TYPED_UI_BASE_COMPONENTS, ...TYPED_UI_EVE_COMPONENTS] as const;

const catalog = {
  Card: {
    description: 'Bounded content surface.',
    props: { title: string(), subtitle: string(), tone: oneOf('neutral', 'info', 'success', 'warning', 'danger') },
    events: [],
    children: true,
  },
  Stack: {
    description: 'Vertical or horizontal layout.',
    props: {
      direction: oneOf('vertical', 'horizontal'),
      gap: number(0, 32),
      align: oneOf('start', 'center', 'end', 'stretch'),
    },
    events: [],
    children: true,
  },
  Grid: {
    description: 'Responsive bounded grid.',
    props: { columns: number(1, 4), gap: number(0, 32) },
    events: [],
    children: true,
  },
  Separator: { description: 'Visual separator.', props: { label: string() }, events: [], children: false },
  Tabs: {
    description: 'State-backed tab set.',
    props: { labels: { kind: 'string_array', required: true }, statePath: statePath(true) },
    events: ['select:*'],
    children: true,
  },
  Accordion: {
    description: 'Accessible disclosure group.',
    props: { title: string(), defaultOpen: boolean() },
    events: [],
    children: true,
  },
  Collapsible: {
    description: 'Single accessible disclosure.',
    props: { label: string(true), defaultOpen: boolean() },
    events: [],
    children: true,
  },
  Dialog: {
    description: 'Inline dialog-style callout; never owns authority.',
    props: { title: string(true), open: boolean() },
    events: [],
    children: true,
  },
  Drawer: {
    description: 'Inline drawer-style callout; never owns authority.',
    props: { title: string(true), open: boolean() },
    events: [],
    children: true,
  },
  Carousel: {
    description: 'Keyboard-operable item group.',
    props: { label: string(true), statePath: statePath() },
    events: [],
    children: true,
  },
  Table: {
    description: 'Read-only data table.',
    props: {
      caption: string(),
      columns: { kind: 'table_columns', required: true },
      rows: { kind: 'table_rows', required: true },
    },
    events: [],
    children: false,
  },
  Heading: {
    description: 'Semantic heading.',
    props: { text: string(true), level: { ...number(1, 4), required: true } },
    events: [],
    children: false,
  },
  Text: {
    description: 'Plain text.',
    props: { text: string(true), tone: oneOf('primary', 'secondary', 'muted', 'success', 'warning', 'danger') },
    events: [],
    children: false,
  },
  Image: {
    description: 'Artifact reference placeholder; never fetches model URLs.',
    props: { artifactRef: string(true), alt: string(true), caption: string() },
    events: ['press'],
    children: false,
  },
  Avatar: {
    description: 'Initials-only avatar; no remote image source.',
    props: { initials: string(true), label: string(true) },
    events: [],
    children: false,
  },
  Badge: {
    description: 'Status badge.',
    props: { text: string(true), tone: oneOf('neutral', 'info', 'success', 'warning', 'danger') },
    events: [],
    children: false,
  },
  Alert: {
    description: 'Semantic alert.',
    props: { title: string(true), description: string(), tone: oneOf('info', 'success', 'warning', 'danger') },
    events: [],
    children: true,
  },
  Progress: {
    description: 'Progress indicator.',
    props: { label: string(true), value: { ...number(0, 100), required: true } },
    events: [],
    children: false,
  },
  Skeleton: {
    description: 'Loading placeholder.',
    props: { lines: number(1, 8), label: string() },
    events: [],
    children: false,
  },
  Spinner: { description: 'Loading status.', props: { label: string(true) }, events: [], children: false },
  Tooltip: {
    description: 'Keyboard-reachable supporting text.',
    props: { content: string(true) },
    events: [],
    children: true,
  },
  Popover: { description: 'Accessible bounded popover.', props: { label: string(true) }, events: [], children: true },
  Input: {
    description: 'State-backed text input.',
    props: {
      label: string(true),
      statePath: statePath(true),
      placeholder: string(),
      required: boolean(),
      maxLength: number(1, 2000),
    },
    events: [],
    children: false,
  },
  Textarea: {
    description: 'State-backed multiline input.',
    props: {
      label: string(true),
      statePath: statePath(true),
      placeholder: string(),
      required: boolean(),
      maxLength: number(1, 8000),
      rows: number(2, 12),
    },
    events: [],
    children: false,
  },
  Select: {
    description: 'State-backed select.',
    props: {
      label: string(true),
      statePath: statePath(true),
      options: { kind: 'options', required: true },
      placeholder: string(),
    },
    events: ['select:*'],
    children: false,
  },
  Checkbox: {
    description: 'State-backed checkbox.',
    props: { label: string(true), statePath: statePath(true) },
    events: [],
    children: false,
  },
  Radio: {
    description: 'State-backed radio group.',
    props: { label: string(true), statePath: statePath(true), options: { kind: 'options', required: true } },
    events: ['select:*'],
    children: false,
  },
  Switch: {
    description: 'State-backed switch.',
    props: { label: string(true), statePath: statePath(true) },
    events: [],
    children: false,
  },
  Slider: {
    description: 'State-backed numeric slider.',
    props: {
      label: string(true),
      statePath: statePath(true),
      min: number(-1000000, 1000000),
      max: number(-1000000, 1000000),
      step: number(0.000001, 1000000),
    },
    events: [],
    children: false,
  },
  Button: {
    description: 'Authority-routed action button.',
    props: { label: string(true), variant: oneOf('primary', 'secondary', 'outline', 'text'), disabled: boolean() },
    events: ['press'],
    children: false,
  },
  Link: {
    description: 'Action-bound link appearance; no href prop.',
    props: { label: string(true) },
    events: ['press'],
    children: false,
  },
  DropdownMenu: {
    description: 'State-backed bounded menu.',
    props: { label: string(true), statePath: statePath(true), options: { kind: 'options', required: true } },
    events: ['select:*'],
    children: false,
  },
  Toggle: {
    description: 'State-backed toggle.',
    props: { label: string(true), statePath: statePath(true) },
    events: [],
    children: false,
  },
  ToggleGroup: {
    description: 'State-backed single-choice toggle group.',
    props: { label: string(true), statePath: statePath(true), options: { kind: 'options', required: true } },
    events: ['select:*'],
    children: false,
  },
  ButtonGroup: { description: 'Groups action buttons.', props: { label: string() }, events: [], children: true },
  Pagination: {
    description: 'State-backed pagination.',
    props: {
      label: string(true),
      statePath: statePath(true),
      total: { ...number(1, 10000), required: true },
      pageSize: number(1, 100),
    },
    events: [],
    children: false,
  },
  Metric: {
    description: 'Read-only metric.',
    props: {
      label: string(true),
      value: string(true),
      delta: string(),
      tone: oneOf('neutral', 'success', 'warning', 'danger'),
    },
    events: [],
    children: false,
  },
  KeyValue: {
    description: 'Read-only key/value list.',
    props: { items: { kind: 'key_value_items', required: true } },
    events: [],
    children: false,
  },
  Code: {
    description: 'Non-executable text/json/log display.',
    props: { content: string(true), language: oneOf('text', 'json', 'markdown', 'log') },
    events: [],
    children: false,
  },
  Markdown: {
    description: 'HTML-disabled markdown display.',
    props: { content: string(true) },
    events: [],
    children: false,
  },
  List: {
    description: 'Read-only string list.',
    props: { items: { kind: 'string_array', required: true }, ordered: boolean() },
    events: [],
    children: false,
  },
  Timeline: {
    description: 'Read-only event timeline.',
    props: { items: { kind: 'timeline_items', required: true } },
    events: [],
    children: false,
  },
  Goal: {
    description: 'EVE-native goal projection; controls require the real durable-work adapter.',
    props: {
      id: string(true),
      title: string(true),
      status: oneOf(
        'planned',
        'active',
        'queued',
        'starting',
        'running',
        'waiting',
        'needs_input',
        'succeeded',
        'failed',
        'stalled',
        'cancelled',
        'reconnect_unavailable',
        'blocked',
        'completed'
      ),
      progress: number(0, 100),
      owner: string(),
      summary: string(),
    },
    events: ['press', 'pause', 'resume', 'cancel'],
    children: true,
    eve_native: true,
  },
  WorkerRun: {
    description: 'EVE-native worker projection; controls require the real durable-work adapter.',
    props: {
      id: string(true),
      worker: string(true),
      status: oneOf(
        'queued',
        'starting',
        'running',
        'waiting',
        'needs_input',
        'succeeded',
        'failed',
        'stalled',
        'cancelled',
        'reconnect_unavailable',
        'blocked',
        'completed'
      ),
      startedAt: string(),
      summary: string(),
      receiptRef: string(),
    },
    events: ['press', 'pause', 'resume', 'cancel'],
    children: true,
    eve_native: true,
  },
  DecisionCard: {
    description: 'EVE-native decision request; action remains external.',
    props: {
      id: string(true),
      title: string(true),
      status: oneOf('open', 'approved', 'rejected', 'deferred'),
      rationale: string(),
      humanGate: oneOf('HG-2.5', 'HG-3', 'HG-4'),
      statePath: statePath(true),
      options: { kind: 'options' },
    },
    events: ['select:*', 'approve'],
    children: true,
    eve_native: true,
  },
} as const satisfies Record<TypedUIComponentName, TypedUIComponentDefinition>;

export const TYPED_UI_CATALOG: Readonly<Record<TypedUIComponentName, TypedUIComponentDefinition>> = catalog;
