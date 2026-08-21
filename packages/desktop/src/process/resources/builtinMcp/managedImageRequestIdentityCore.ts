/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import nodeCrypto from 'node:crypto';

export const COMMAND_EVE_MANAGED_IMAGE_REQUEST_META_KEY = 'hermes';

const REQUEST_ID_DOMAIN_SEPARATOR = Buffer.from('hermes.logical-call-id.v1\0', 'utf8');
const REQUEST_ID_TEST_COMPONENTS = [
  'node-smoke-session',
  'node-smoke-turn',
  'node-smoke-tool-call',
  'aionui-image-generation.aionui_image_generation',
] as const;

const LOGICAL_CALL_ID_PATTERN = /^[a-f0-9]{64}$/;
const REQUEST_ID_COMPONENTS = [
  'node-smoke-session',
  'node-smoke-turn',
  'node-smoke-tool-call',
  'aionui-image-generation.aionui_image_generation',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readLogicalCallId(value: unknown): string | undefined {
  return typeof value === 'string' && LOGICAL_CALL_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * Reads the opaque Hermes-owned idempotency key for the managed MCP lane.
 * The raw session, turn, tool and route values remain inside Hermes.
 */
export function readCommandEveManagedImageRequestId(meta: unknown): string | undefined {
  if (!isRecord(meta) || !isRecord(meta[COMMAND_EVE_MANAGED_IMAGE_REQUEST_META_KEY])) return undefined;
  const logical = meta[COMMAND_EVE_MANAGED_IMAGE_REQUEST_META_KEY];
  return readLogicalCallId(logical.logicalCallId);
}

/**
 * Test-only helper: derive the opaque ID exactly as Hermes' bundled wheel does.
 * It must not be used by production code; the running agent remains the sole
 * source of a valid logical call identity.
 */
export function deriveCommandEveManagedImageRequestId(): string {
  const digest = nodeCrypto.createHash('sha256').update(REQUEST_ID_DOMAIN_SEPARATOR);
  for (const component of REQUEST_ID_TEST_COMPONENTS) {
    const encoded = Buffer.from(component, 'utf8');
    digest.update(new Uint8Array(new Uint32Array([encoded.length]).buffer));
    digest.update(encoded);
  }
  return digest.digest('hex');
}
