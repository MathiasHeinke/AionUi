/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

import {
  CUSTOMER_DEFAULT_KANBAN_PROVIDER_KEYS,
  FOUNDER_ONLY_PROVIDER_KEYS,
  RENDERER_PROVIDER_KEYS,
  RENDERER_PROVIDER_PAYLOAD_CLASSES,
  type ProviderPayloadClass,
  type RendererProviderKey,
} from './providerRegistry';

export type AdapterWireAuthorization = 'trusted-main' | 'founder-only' | 'customer-default-kanban';

export type AdapterWirePolicy = Readonly<{
  providerKey: RendererProviderKey;
  wireName: `subscribe-${RendererProviderKey}`;
  direction: 'renderer-to-main';
  schema: `office-ai-provider-envelope/v1:${ProviderPayloadClass}`;
  payloadClass: ProviderPayloadClass;
  authorization: AdapterWireAuthorization;
}>;

export type ProviderInvocationEnvelope = Readonly<{
  id: string;
  data?: unknown;
}>;

export type RendererToMainAdapterEvent = Readonly<{
  name: string;
  data: ProviderInvocationEnvelope;
}>;

type ParseRendererAdapterEventOptions = Readonly<{
  maxPayloadBytes: number;
  founderBuild: boolean;
}>;

const PROVIDER_POLICY_BY_WIRE_NAME: ReadonlyMap<string, AdapterWirePolicy> = new Map(
  RENDERER_PROVIDER_KEYS.map((providerKey) => {
    const wireName = `subscribe-${providerKey}` as const;
    const payloadClass = RENDERER_PROVIDER_PAYLOAD_CLASSES[providerKey];
    return [
      wireName,
      {
        providerKey,
        wireName,
        direction: 'renderer-to-main',
        schema: `office-ai-provider-envelope/v1:${payloadClass}`,
        payloadClass,
        authorization: CUSTOMER_DEFAULT_KANBAN_PROVIDER_KEYS.has(providerKey)
          ? 'customer-default-kanban'
          : FOUNDER_ONLY_PROVIDER_KEYS.has(providerKey)
            ? 'founder-only'
            : 'trusted-main',
      },
    ];
  })
);

const BRIDGE_EVENT_KEYS = new Set(['name', 'data']);
const PROVIDER_ENVELOPE_KEYS = new Set(['id', 'data']);
const DANGEROUS_PAYLOAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PAYLOAD_NESTING_DEPTH = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isProviderInvocationId(providerKey: string, value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(providerKey)) return false;
  const nonce = value.slice(providerKey.length);
  return /^[0-9a-f]{1,8}$/.test(nonce);
}

function assertSafeStructuredPayload(value: unknown, depth = 0): void {
  if (depth > MAX_PAYLOAD_NESTING_DEPTH) {
    throw new Error('Adapter provider payload exceeds the allowed nesting depth.');
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeStructuredPayload(item, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (DANGEROUS_PAYLOAD_KEYS.has(key)) {
      throw new Error('Adapter provider payload contains a blocked prototype key.');
    }
    assertSafeStructuredPayload(nested, depth + 1);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertExactStringPayload(
  payload: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = []
): void {
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  if (!hasOnlyKeys(payload, allowedKeys)) throw new Error('Invalid adapter provider event payload keys.');
  for (const key of requiredKeys) {
    if (!Object.hasOwn(payload, key) || !isNonEmptyString(payload[key])) {
      throw new Error(`Invalid adapter provider event payload field: ${key}.`);
    }
  }
  for (const key of optionalKeys) {
    if (Object.hasOwn(payload, key) && !isNonEmptyString(payload[key])) {
      throw new Error(`Invalid adapter provider event payload field: ${key}.`);
    }
  }
}

function assertHighRiskProviderPayload(providerKey: RendererProviderKey, payload: Record<string, unknown>): void {
  switch (providerKey) {
    case 'update-system-info':
      assertExactStringPayload(payload, ['cacheDir', 'workDir'], ['logDir']);
      return;
    case 'command-eve.team-manage-apply':
    case 'command-eve.team-manage-reject':
    case 'command-eve.kanban-acp-reject':
      assertExactStringPayload(payload, ['intent_id']);
      return;
    case 'command-eve.kanban-acp-apply':
      assertExactStringPayload(payload, ['intent_id', 'mutation_hash']);
      return;
    case 'command-eve.managed-visual-turn-authorize': {
      const allowedKeys = new Set(['consentVersion', 'preferredTier', 'sourceCount']);
      if (!hasOnlyKeys(payload, allowedKeys)) throw new Error('Invalid managed visual turn payload keys.');
      if (payload.consentVersion !== 'command-eve-managed-visual-turn-consent/v1') {
        throw new Error('Invalid managed visual turn consent version.');
      }
      if (
        !Number.isInteger(payload.sourceCount) ||
        Number(payload.sourceCount) < 1 ||
        Number(payload.sourceCount) > 6
      ) {
        throw new Error('Invalid managed visual turn source count.');
      }
      if (
        Object.hasOwn(payload, 'preferredTier') &&
        !['high', 'xhigh', 'max', 'ultra'].includes(String(payload.preferredTier))
      ) {
        throw new Error('Invalid managed visual turn preferred tier.');
      }
      return;
    }
    case 'command-eve.report-export': {
      const allowedKeys = new Set(['format', 'markdown', 'seatId', 'outputPath', 'title', 'brand']);
      if (!hasOnlyKeys(payload, allowedKeys)) throw new Error('Invalid report-export payload keys.');
      if (!['pdf', 'docx', 'md'].includes(String(payload.format))) {
        throw new Error('Invalid report-export format.');
      }
      if (typeof payload.markdown !== 'string') throw new Error('Invalid report-export markdown.');
      if (!isNonEmptyString(payload.seatId)) throw new Error('Invalid report-export seatId.');
      if (!isNonEmptyString(payload.outputPath) || !path.isAbsolute(payload.outputPath)) {
        throw new Error('Invalid report-export outputPath.');
      }
      if (Object.hasOwn(payload, 'title') && typeof payload.title !== 'string') {
        throw new Error('Invalid report-export title.');
      }
      if (Object.hasOwn(payload, 'brand')) {
        if (
          !isRecord(payload.brand) ||
          !hasOnlyKeys(payload.brand, new Set(['displayName', 'logoDataUri', 'footer']))
        ) {
          throw new Error('Invalid report-export brand.');
        }
        for (const key of ['displayName', 'logoDataUri', 'footer'] as const) {
          if (Object.hasOwn(payload.brand, key) && typeof payload.brand[key] !== 'string') {
            throw new Error(`Invalid report-export brand field: ${key}.`);
          }
        }
        if (
          Object.hasOwn(payload.brand, 'logoDataUri') &&
          isNonEmptyString(payload.brand.logoDataUri) &&
          !payload.brand.logoDataUri.startsWith('data:')
        ) {
          throw new Error('Invalid report-export logoDataUri.');
        }
      }
      return;
    }
    default:
      return;
  }
}

function assertConditionalKanbanPayload(
  providerKey: RendererProviderKey,
  payload: Record<string, unknown>,
  founderBuild: boolean
): void {
  switch (providerKey) {
    case 'command-eve.kanban-marketing-board':
      assertExactStringPayload(payload, ['boardSlug']);
      break;
    case 'command-eve.kanban-marketing-card-create':
      assertExactStringPayload(
        payload,
        ['title', 'lane_key', 'client_token', 'boardSlug'],
        founderBuild ? ['description', 'eventLedgerPath'] : ['description']
      );
      break;
    case 'command-eve.kanban-marketing-card-move':
      assertExactStringPayload(
        payload,
        ['task_id', 'to_lane_key', 'boardSlug'],
        founderBuild ? ['eventLedgerPath'] : []
      );
      break;
    case 'command-eve.kanban-marketing-card-action':
      assertExactStringPayload(
        payload,
        ['task_id', 'action', 'boardSlug'],
        founderBuild ? ['comment', 'eventLedgerPath'] : ['comment']
      );
      if (!['comment', 'block', 'unblock', 'complete'].includes(String(payload.action))) {
        throw new Error('Invalid Kanban card action.');
      }
      break;
    default:
      throw new Error('Invalid conditional Kanban provider.');
  }

  if (!founderBuild && payload.boardSlug !== 'default') {
    throw new Error('Blocked founder-only Kanban board.');
  }
}

/**
 * Parses and authorizes a single renderer-to-main Office AI provider invocation.
 *
 * Raw emitter names, callback names, unknown providers, prefix lookalikes and
 * malformed provider envelopes all fail closed before reaching EventEmitter.
 */
export function parseRendererToMainAdapterEvent(
  info: unknown,
  options: ParseRendererAdapterEventOptions
): RendererToMainAdapterEvent {
  if (typeof info !== 'string') throw new Error('Invalid adapter bridge payload type.');
  if (Buffer.byteLength(info, 'utf8') > options.maxPayloadBytes) {
    throw new Error('Adapter bridge payload exceeds the allowed size.');
  }

  const parsed = JSON.parse(info) as unknown;
  if (
    !isRecord(parsed) ||
    !Object.hasOwn(parsed, 'name') ||
    !Object.hasOwn(parsed, 'data') ||
    !hasOnlyKeys(parsed, BRIDGE_EVENT_KEYS) ||
    typeof parsed.name !== 'string'
  ) {
    throw new Error('Invalid adapter bridge event shape.');
  }

  const policy = PROVIDER_POLICY_BY_WIRE_NAME.get(parsed.name);
  if (!policy) throw new Error('Blocked unknown adapter bridge event.');

  if (
    !isRecord(parsed.data) ||
    !Object.hasOwn(parsed.data, 'id') ||
    !hasOnlyKeys(parsed.data, PROVIDER_ENVELOPE_KEYS) ||
    !isProviderInvocationId(policy.providerKey, parsed.data.id)
  ) {
    throw new Error('Invalid adapter provider envelope.');
  }

  const hasPayload = Object.hasOwn(parsed.data, 'data');
  if (policy.payloadClass === 'void' && hasPayload) {
    throw new Error('Invalid adapter provider event payload: expected void.');
  }
  if (policy.payloadClass === 'record' && (!hasPayload || !isRecord(parsed.data.data))) {
    throw new Error('Invalid adapter provider event payload: expected record.');
  }
  if (policy.payloadClass === 'optional-record' && hasPayload && !isRecord(parsed.data.data)) {
    throw new Error('Invalid adapter provider event payload: expected optional record.');
  }
  if (hasPayload) {
    assertSafeStructuredPayload(parsed.data.data);
    assertHighRiskProviderPayload(policy.providerKey, parsed.data.data as Record<string, unknown>);
  }

  if (policy.authorization === 'customer-default-kanban') {
    if (!hasPayload || !isRecord(parsed.data.data)) {
      throw new Error('Invalid conditional Kanban payload.');
    }
    assertConditionalKanbanPayload(policy.providerKey, parsed.data.data, options.founderBuild);
  }

  if (policy.authorization === 'founder-only' && !options.founderBuild) {
    throw new Error(`Blocked founder-only adapter bridge event: ${policy.providerKey}.`);
  }

  return {
    name: policy.wireName,
    data: {
      id: parsed.data.id,
      ...(Object.hasOwn(parsed.data, 'data') ? { data: parsed.data.data } : {}),
    },
  };
}

export function getRendererToMainAdapterPolicy(name: string): AdapterWirePolicy | null {
  return PROVIDER_POLICY_BY_WIRE_NAME.get(name) ?? null;
}
