/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FOUNDER_ONLY_PROVIDER_KEYS,
  RENDERER_PROVIDER_KEYS,
  RENDERER_PROVIDER_PAYLOAD_CLASSES,
  type ProviderPayloadClass,
  type RendererProviderKey,
} from './providerRegistry';

export type AdapterWireAuthorization = 'trusted-main' | 'founder-only';

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
        authorization: FOUNDER_ONLY_PROVIDER_KEYS.has(providerKey) ? 'founder-only' : 'trusted-main',
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
    default:
      return;
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

  if (policy.authorization === 'founder-only' && !options.founderBuild) {
    throw new Error('Blocked founder-only adapter bridge event.');
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
