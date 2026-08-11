/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { TYPED_UI_CATALOG, TYPED_UI_COMPONENTS, type TypedUIPropRule } from './catalog';
import {
  TYPED_UI_CATALOG_VERSION,
  TYPED_UI_SCHEMA_VERSION,
  type TypedUIActionDefinition,
  type TypedUIActionType,
  type TypedUIComponentName,
  type TypedUIElement,
  type TypedUIJsonValue,
  type TypedUIProvenance,
  type TypedUIValidationIssue,
  type TypedUIValidationResult,
} from './types';

export const TYPED_UI_MAX_BYTES = 512 * 1024;
export const TYPED_UI_MAX_ELEMENTS = 200;
export const TYPED_UI_MAX_ACTIONS = 50;

const COMPONENTS = new Set<string>(TYPED_UI_COMPONENTS);
const ACTIONS = new Set<TypedUIActionType>([
  'reply_with_state',
  'open_artifact',
  'open_url',
  'select_option',
  'request_approval',
  'goal_control',
  'worker_control',
]);
const ARTIFACT_KINDS = new Set(['chat', 'file', 'browser', 'goal', 'worker']);
const LIFECYCLE_CONTROLS = new Set(['pause', 'resume', 'cancel']);
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const GATE_ACTIONS = new Set([
  'edit_code',
  'prepare_pr',
  'run_local_tests',
  'merge_main',
  'prod_write',
  'money',
  'external_send',
  'schema_auth_secret',
  'truth_gate',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key) && !FORBIDDEN_KEYS.has(key));
}

function pushIssue(issues: TypedUIValidationIssue[], code: string, path: string, message: string): void {
  if (issues.length < 100) issues.push({ code, path, message });
}

function isJsonValue(value: unknown, depth = 0): value is TypedUIJsonValue {
  if (depth > 8) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 100 && value.every((item) => isJsonValue(item, depth + 1));
  if (!isRecord(value) || Object.keys(value).length > 100) return false;
  return Object.entries(value).every(
    ([key, item]) => !FORBIDDEN_KEYS.has(key) && key.length <= 128 && isJsonValue(item, depth + 1)
  );
}

function isBoundedString(value: unknown, max = 8000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function statePathSegments(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/')) return undefined;
  const segments = value
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (
    segments.length === 0 ||
    segments.length > 8 ||
    segments.some((segment) => !IDENTIFIER.test(segment) || FORBIDDEN_KEYS.has(segment))
  ) {
    return undefined;
  }
  return segments;
}

export function isSafeTypedUIStatePath(value: unknown): value is string {
  return statePathSegments(value) !== undefined;
}

function statePathExists(state: Record<string, unknown>, statePath: string): boolean {
  const segments = statePathSegments(statePath);
  if (!segments) return false;
  let current: unknown = state;
  for (const segment of segments) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

function validateOptions(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 50 &&
    value.every(
      (option) =>
        isRecord(option) &&
        exactKeys(option, ['id', 'label', 'description', 'disabled']) &&
        typeof option.id === 'string' &&
        IDENTIFIER.test(option.id) &&
        isBoundedString(option.label, 500) &&
        (option.description === undefined || isBoundedString(option.description, 1000)) &&
        (option.disabled === undefined || typeof option.disabled === 'boolean')
    )
  );
}

function validateComplexProp(kind: TypedUIPropRule['kind'], value: unknown): boolean {
  if (kind === 'string_array') {
    return Array.isArray(value) && value.length <= 100 && value.every((item) => isBoundedString(item, 2000));
  }
  if (kind === 'options') return validateOptions(value);
  if (kind === 'table_columns') {
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 12 &&
      value.every(
        (column) =>
          isRecord(column) &&
          exactKeys(column, ['key', 'label']) &&
          IDENTIFIER.test(String(column.key)) &&
          isBoundedString(column.label, 200)
      )
    );
  }
  if (kind === 'table_rows') {
    return (
      Array.isArray(value) &&
      value.length <= 100 &&
      value.every(
        (row) =>
          isRecord(row) &&
          Object.keys(row).length <= 12 &&
          Object.entries(row).every(
            ([key, cell]) =>
              IDENTIFIER.test(key) &&
              (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean' || cell === null)
          )
      )
    );
  }
  if (kind === 'key_value_items') {
    return (
      Array.isArray(value) &&
      value.length <= 50 &&
      value.every(
        (item) =>
          isRecord(item) &&
          exactKeys(item, ['key', 'value']) &&
          isBoundedString(item.key, 200) &&
          isBoundedString(item.value, 2000)
      )
    );
  }
  if (kind === 'timeline_items') {
    return (
      Array.isArray(value) &&
      value.length <= 50 &&
      value.every(
        (item) =>
          isRecord(item) &&
          exactKeys(item, ['title', 'description', 'time', 'status']) &&
          isBoundedString(item.title, 500) &&
          (item.description === undefined || isBoundedString(item.description, 2000)) &&
          (item.time === undefined || isBoundedString(item.time, 200)) &&
          (item.status === undefined || ['pending', 'active', 'completed', 'blocked'].includes(String(item.status)))
      )
    );
  }
  return false;
}

function validateProp(rule: TypedUIPropRule, value: unknown): boolean {
  if (rule.values && !rule.values.includes(value as TypedUIJsonValue)) return false;
  if (rule.kind === 'string') return isBoundedString(value);
  if (rule.kind === 'boolean') return typeof value === 'boolean';
  if (rule.kind === 'number') {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (rule.minimum === undefined || value >= rule.minimum) &&
      (rule.maximum === undefined || value <= rule.maximum)
    );
  }
  if (rule.kind === 'state_path') return isSafeTypedUIStatePath(value);
  return validateComplexProp(rule.kind, value);
}

function validateElement(id: string, raw: unknown, issues: TypedUIValidationIssue[]): TypedUIElement | undefined {
  const path = `$.elements.${id}`;
  if (!IDENTIFIER.test(id)) pushIssue(issues, 'element.invalid_id', path, 'Element IDs must be bounded identifiers.');
  if (!isRecord(raw) || !exactKeys(raw, ['type', 'props', 'children', 'on'])) {
    pushIssue(issues, 'element.invalid_shape', path, 'Element fields are limited to type, props, children and on.');
    return undefined;
  }
  if (typeof raw.type !== 'string' || !COMPONENTS.has(raw.type)) {
    pushIssue(issues, 'element.unknown_component', `${path}.type`, 'Component is not in catalog v1.');
    return undefined;
  }
  const type = raw.type as TypedUIComponentName;
  const definition = TYPED_UI_CATALOG[type];
  if (!isRecord(raw.props) || !exactKeys(raw.props, Object.keys(definition.props))) {
    pushIssue(issues, 'element.invalid_props', `${path}.props`, 'Props must exactly match the renderer-owned catalog.');
    return undefined;
  }
  const validatedProps: Record<string, unknown> = raw.props;
  for (const [name, rule] of Object.entries(definition.props)) {
    const value = raw.props[name];
    if (value === undefined) {
      if (rule.required)
        pushIssue(issues, 'element.missing_prop', `${path}.props.${name}`, 'Required prop is missing.');
      continue;
    }
    if (!validateProp(rule, value))
      pushIssue(issues, 'element.invalid_prop', `${path}.props.${name}`, 'Prop violates its catalog rule.');
  }
  if (
    !Array.isArray(raw.children) ||
    raw.children.length > 40 ||
    raw.children.some((child) => typeof child !== 'string')
  ) {
    pushIssue(
      issues,
      'element.invalid_children',
      `${path}.children`,
      'Children must be a bounded array of element IDs.'
    );
    return undefined;
  }
  if (!definition.children && raw.children.length > 0) {
    pushIssue(issues, 'element.children_forbidden', `${path}.children`, 'Leaf components cannot contain children.');
  }
  let on: Record<string, string> | undefined;
  if (raw.on !== undefined) {
    const allowedEvent = (event: string): boolean => {
      if (definition.events.includes(event)) return true;
      if (!definition.events.includes('select:*') || !event.startsWith('select:')) return false;
      const optionId = event.slice('select:'.length);
      if (type === 'Tabs') {
        return (
          /^\d{1,2}$/.test(optionId) &&
          Number(optionId) < (Array.isArray(validatedProps.labels) ? validatedProps.labels.length : 0)
        );
      }
      const options: unknown[] = Array.isArray(validatedProps.options) ? validatedProps.options : [];
      return options.some((option) => isRecord(option) && option.id === optionId);
    };
    if (!isRecord(raw.on) || Object.keys(raw.on).some((event) => !allowedEvent(event) || FORBIDDEN_KEYS.has(event))) {
      pushIssue(issues, 'element.invalid_events', `${path}.on`, 'Events must be declared by the selected component.');
    } else {
      on = {};
      for (const [event, actionId] of Object.entries(raw.on)) {
        if (typeof actionId !== 'string' || !IDENTIFIER.test(actionId)) {
          pushIssue(
            issues,
            'element.invalid_action_ref',
            `${path}.on.${event}`,
            'Action references must be bounded IDs.'
          );
        } else {
          on[event] = actionId;
        }
      }
    }
  }
  return {
    type,
    props: raw.props as Record<string, TypedUIJsonValue>,
    children: raw.children as string[],
    ...(on ? { on } : {}),
  };
}

function validateAction(
  id: string,
  raw: unknown,
  issues: TypedUIValidationIssue[]
): TypedUIActionDefinition | undefined {
  const path = `$.actions.${id}`;
  if (!IDENTIFIER.test(id)) pushIssue(issues, 'action.invalid_id', path, 'Action IDs must be bounded identifiers.');
  if (!isRecord(raw) || !exactKeys(raw, ['type', 'params']) || !isRecord(raw.params)) {
    pushIssue(issues, 'action.invalid_shape', path, 'Actions require only type and params.');
    return undefined;
  }
  if (typeof raw.type !== 'string' || !ACTIONS.has(raw.type as TypedUIActionType)) {
    pushIssue(issues, 'action.not_allowed', `${path}.type`, 'Action is not in the v1 allowlist.');
    return undefined;
  }
  const type = raw.type as TypedUIActionType;
  const params = raw.params;
  let valid = true;
  if (type === 'reply_with_state') {
    valid =
      exactKeys(params, ['state_paths', 'message']) &&
      (params.state_paths === undefined ||
        (Array.isArray(params.state_paths) &&
          params.state_paths.length <= 20 &&
          params.state_paths.every((item) => isSafeTypedUIStatePath(item)))) &&
      (params.message === undefined || isBoundedString(params.message, 500));
  } else if (type === 'open_artifact') {
    valid =
      exactKeys(params, ['artifact_kind', 'artifact_id']) &&
      typeof params.artifact_kind === 'string' &&
      ARTIFACT_KINDS.has(params.artifact_kind) &&
      isBoundedString(params.artifact_id, 128);
  } else if (type === 'open_url') {
    valid =
      exactKeys(params, ['url', 'label']) &&
      isBoundedString(params.url, 2048) &&
      isHttpUrl(params.url) &&
      (params.label === undefined || isBoundedString(params.label, 500));
  } else if (type === 'select_option') {
    valid =
      exactKeys(params, ['state_path', 'value', 'option_id']) &&
      isSafeTypedUIStatePath(params.state_path) &&
      (params.value === null || ['string', 'number', 'boolean'].includes(typeof params.value)) &&
      typeof params.option_id === 'string' &&
      IDENTIFIER.test(params.option_id);
  } else if (type === 'request_approval') {
    valid =
      exactKeys(params, ['gate_action', 'summary']) &&
      typeof params.gate_action === 'string' &&
      GATE_ACTIONS.has(params.gate_action) &&
      isBoundedString(params.summary, 500);
  } else if (type === 'goal_control' || type === 'worker_control') {
    const identityKey = type === 'goal_control' ? 'goal_id' : 'worker_id';
    valid =
      exactKeys(params, [identityKey, 'action', 'expected_revision', 'expected_sequence']) &&
      isBoundedString(params[identityKey], 128) &&
      typeof params.action === 'string' &&
      LIFECYCLE_CONTROLS.has(params.action) &&
      Number.isSafeInteger(params.expected_revision) &&
      Number(params.expected_revision) >= 0 &&
      Number(params.expected_revision) <= 1_000_000_000 &&
      Number.isSafeInteger(params.expected_sequence) &&
      Number(params.expected_sequence) >= 0 &&
      Number(params.expected_sequence) <= 1_000_000_000;
  }
  if (!valid || !isJsonValue(params)) {
    pushIssue(
      issues,
      'action.invalid_params',
      `${path}.params`,
      'Action params violate the strict versioned contract.'
    );
    return undefined;
  }
  return { type, params: params as Record<string, TypedUIJsonValue> };
}

function validateProvenance(raw: unknown, issues: TypedUIValidationIssue[]): TypedUIProvenance | undefined {
  if (!isRecord(raw) || !exactKeys(raw, ['provider', 'model', 'request_id', 'generated_at', 'source_message_id'])) {
    pushIssue(issues, 'provenance.invalid_shape', '$.provenance', 'Provenance fields are strict and versioned.');
    return undefined;
  }
  const required = ['provider', 'model', 'request_id', 'generated_at', 'source_message_id'] as const;
  if (required.some((key) => !isBoundedString(raw[key], 500))) {
    pushIssue(
      issues,
      'provenance.missing_field',
      '$.provenance',
      'Provider, model, request_id, generated_at and source_message_id are required.'
    );
    return undefined;
  }
  if (Number.isNaN(Date.parse(String(raw.generated_at)))) {
    pushIssue(
      issues,
      'provenance.invalid_time',
      '$.provenance.generated_at',
      'generated_at must be an ISO-compatible timestamp.'
    );
    return undefined;
  }
  return raw as unknown as TypedUIProvenance;
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function isCompatibleActionBinding(element: TypedUIElement, event: string, action: TypedUIActionDefinition): boolean {
  if (event.startsWith('select:')) {
    const optionId = event.slice('select:'.length);
    return (
      action.type === 'select_option' &&
      action.params.option_id === optionId &&
      action.params.value === optionId &&
      action.params.state_path === element.props.statePath
    );
  }
  if (event === 'approve') return element.type === 'DecisionCard' && action.type === 'request_approval';
  if (event === 'pause' || event === 'resume' || event === 'cancel') {
    if (element.type === 'Goal' && action.type === 'goal_control') {
      return action.params.action === event && action.params.goal_id === element.props.id;
    }
    if (element.type === 'WorkerRun' && action.type === 'worker_control') {
      return action.params.action === event && action.params.worker_id === element.props.id;
    }
    return false;
  }
  if (event !== 'press') return false;
  if (action.type === 'reply_with_state') return element.type === 'Button';
  if (action.type === 'open_url') return element.type === 'Button' || element.type === 'Link';
  if (action.type === 'request_approval') return element.type === 'Button';
  if (action.type === 'open_artifact') {
    if (!['Button', 'Link', 'Image', 'Goal', 'WorkerRun'].includes(element.type)) return false;
    if (element.type === 'Goal') {
      return action.params.artifact_kind === 'goal' && action.params.artifact_id === element.props.id;
    }
    if (element.type === 'WorkerRun') {
      return action.params.artifact_kind === 'worker' && action.params.artifact_id === element.props.id;
    }
    return true;
  }
  return false;
}

export function validateTypedUIEnvelope(input: unknown): TypedUIValidationResult {
  const issues: TypedUIValidationIssue[] = [];
  if (
    !isRecord(input) ||
    !exactKeys(input, ['schema_version', 'catalog_version', 'root', 'elements', 'state', 'actions', 'provenance'])
  ) {
    return {
      ok: false,
      issues: [
        {
          code: 'envelope.invalid_shape',
          path: '$',
          message: 'Typed UI envelope has unknown or missing top-level fields.',
        },
      ],
    };
  }
  if (input.schema_version !== TYPED_UI_SCHEMA_VERSION)
    pushIssue(issues, 'envelope.schema_version', '$.schema_version', 'Unsupported schema version.');
  if (input.catalog_version !== TYPED_UI_CATALOG_VERSION)
    pushIssue(issues, 'envelope.catalog_version', '$.catalog_version', 'Unsupported catalog version.');
  if (typeof input.root !== 'string' || !IDENTIFIER.test(input.root))
    pushIssue(issues, 'envelope.invalid_root', '$.root', 'Root must be a bounded element ID.');
  if (
    !isRecord(input.elements) ||
    Object.keys(input.elements).length === 0 ||
    Object.keys(input.elements).length > TYPED_UI_MAX_ELEMENTS
  ) {
    pushIssue(
      issues,
      'envelope.invalid_elements',
      '$.elements',
      `Elements must contain 1-${TYPED_UI_MAX_ELEMENTS} entries.`
    );
  }
  if (!isRecord(input.actions) || Object.keys(input.actions).length > TYPED_UI_MAX_ACTIONS) {
    pushIssue(
      issues,
      'envelope.invalid_actions',
      '$.actions',
      `Actions must contain at most ${TYPED_UI_MAX_ACTIONS} entries.`
    );
  }
  if (!isRecord(input.state) || !isJsonValue(input.state))
    pushIssue(issues, 'envelope.invalid_state', '$.state', 'State must be bounded JSON data.');

  const elements: Record<string, TypedUIElement> = {};
  if (isRecord(input.elements)) {
    for (const [id, raw] of Object.entries(input.elements)) {
      const element = validateElement(id, raw, issues);
      if (element) elements[id] = element;
    }
  }
  const actions: Record<string, TypedUIActionDefinition> = {};
  if (isRecord(input.actions)) {
    for (const [id, raw] of Object.entries(input.actions)) {
      const action = validateAction(id, raw, issues);
      if (action) actions[id] = action;
    }
  }
  const provenance = validateProvenance(input.provenance, issues);
  if (typeof input.root === 'string' && !elements[input.root])
    pushIssue(issues, 'tree.root_missing', '$.root', 'Root element does not exist.');

  const referencedActions = new Set<string>();
  for (const [id, element] of Object.entries(elements)) {
    for (const child of element.children) {
      if (!elements[child])
        pushIssue(issues, 'tree.child_missing', `$.elements.${id}.children`, `Missing child element: ${child}.`);
    }
    for (const [event, actionId] of Object.entries(element.on || {})) {
      referencedActions.add(actionId);
      const action = actions[actionId];
      if (!action) {
        pushIssue(issues, 'tree.action_missing', `$.elements.${id}.on`, `Missing action: ${actionId}.`);
      } else if (!isCompatibleActionBinding(element, event, action)) {
        pushIssue(
          issues,
          'tree.action_incompatible',
          `$.elements.${id}.on.${event}`,
          'Action is not compatible with this explicit user event.'
        );
      }
    }
  }
  for (const actionId of Object.keys(actions)) {
    if (!referencedActions.has(actionId))
      pushIssue(issues, 'tree.unused_action', `$.actions.${actionId}`, 'Unreferenced actions are rejected.');
  }

  if (isRecord(input.state)) {
    for (const [id, element] of Object.entries(elements)) {
      const statePath = element.props.statePath;
      if (typeof statePath === 'string' && !statePathExists(input.state, statePath)) {
        pushIssue(
          issues,
          'tree.state_path_missing',
          `$.elements.${id}.props.statePath`,
          'Interactive state paths must already exist in the initial state.'
        );
      }
    }
    for (const [id, action] of Object.entries(actions)) {
      const paths =
        action.type === 'reply_with_state'
          ? Array.isArray(action.params.state_paths)
            ? action.params.state_paths
            : []
          : action.type === 'select_option'
            ? [action.params.state_path]
            : [];
      for (const statePath of paths) {
        if (typeof statePath === 'string' && !statePathExists(input.state, statePath)) {
          pushIssue(
            issues,
            'tree.state_path_missing',
            `$.actions.${id}.params`,
            'Action state paths must already exist in the initial state.'
          );
        }
      }
    }
  }

  if (typeof input.root === 'string' && elements[input.root]) {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const walk = (id: string): void => {
      if (visiting.has(id)) {
        pushIssue(issues, 'tree.cycle', `$.elements.${id}`, 'Element graph must be acyclic.');
        return;
      }
      if (visited.has(id) || !elements[id]) return;
      visiting.add(id);
      for (const child of elements[id].children) walk(child);
      visiting.delete(id);
      visited.add(id);
    };
    walk(input.root);
    for (const id of Object.keys(elements)) {
      if (!visited.has(id))
        pushIssue(issues, 'tree.unreachable', `$.elements.${id}`, 'Unreachable elements are rejected.');
    }
  }

  if (issues.length > 0 || !provenance || !isRecord(input.state)) return { ok: false, issues };
  return {
    ok: true,
    value: {
      schema_version: TYPED_UI_SCHEMA_VERSION,
      catalog_version: TYPED_UI_CATALOG_VERSION,
      root: input.root as string,
      elements,
      state: input.state as Record<string, TypedUIJsonValue>,
      actions,
      provenance,
    },
  };
}

export function parseTypedUIEnvelope(input: string | unknown): TypedUIValidationResult {
  if (typeof input !== 'string') return validateTypedUIEnvelope(input);
  const bytes = new TextEncoder().encode(input).byteLength;
  if (bytes > TYPED_UI_MAX_BYTES) {
    return {
      ok: false,
      issues: [{ code: 'envelope.too_large', path: '$', message: `Typed UI exceeds ${TYPED_UI_MAX_BYTES} bytes.` }],
    };
  }
  try {
    return validateTypedUIEnvelope(JSON.parse(input) as unknown);
  } catch {
    return {
      ok: false,
      issues: [{ code: 'envelope.invalid_json', path: '$', message: 'Typed UI is not valid JSON.' }],
    };
  }
}
