/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Canonical connector identifiers are security-sensitive filename components.
 * Keep the grammar deliberately smaller than a generic capability id: lowercase
 * ASCII letters/digits plus interior `-`/`_`, 1..96 bytes, with no trimming or
 * Unicode normalization. A request and manifest therefore have exactly one
 * byte representation and can never alias `.`/`..` or a path separator.
 */

const CANONICAL_CONNECTOR_ID = /^[a-z0-9](?:[a-z0-9_-]{0,94}[a-z0-9])?$/;

export type CanonicalConnectorIdResult = Readonly<
  | { ok: true; connectorId: string }
  | { ok: false; reason_code: 'CONNECTOR_ID_NOT_STRING' | 'CONNECTOR_ID_NOT_CANONICAL' }
>;

export function resolveCanonicalConnectorId(value: unknown): CanonicalConnectorIdResult {
  if (typeof value !== 'string') return { ok: false, reason_code: 'CONNECTOR_ID_NOT_STRING' };
  if (value.length === 0 || value.length > 96 || value.normalize('NFC') !== value) {
    return { ok: false, reason_code: 'CONNECTOR_ID_NOT_CANONICAL' };
  }
  if (!CANONICAL_CONNECTOR_ID.test(value)) {
    return { ok: false, reason_code: 'CONNECTOR_ID_NOT_CANONICAL' };
  }
  return { ok: true, connectorId: value };
}
