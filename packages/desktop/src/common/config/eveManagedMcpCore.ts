/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BUILTIN_IMAGE_GEN_ID,
  BUILTIN_IMAGE_GEN_LEGACY_NAMES,
  BUILTIN_IMAGE_GEN_NAME,
  type IConversationMcpStatus,
} from './storage';

type McpIdentity = Readonly<{ id?: unknown; name?: unknown }>;

/**
 * The image generator is an app-owned Hermes capability. It is provisioned in
 * the signed runtime config and is neither a user connector nor a per-session
 * ACP attachment.
 */
export function isCommandEveManagedImageMcp(value: McpIdentity): boolean {
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const identities = new Set<string>([BUILTIN_IMAGE_GEN_ID, BUILTIN_IMAGE_GEN_NAME, ...BUILTIN_IMAGE_GEN_LEGACY_NAMES]);
  return identities.has(id) || identities.has(name);
}

/** Hide app plumbing from the connector menu, including stale legacy status snapshots. */
export function userVisibleConversationMcpStatuses(
  statuses?: readonly IConversationMcpStatus[],
  legacyNames?: readonly string[]
): IConversationMcpStatus[] {
  const resolved =
    Array.isArray(statuses) && statuses.length > 0
      ? statuses
      : (legacyNames ?? []).map((name) => ({ id: name, name, status: 'loaded' as const }));
  return resolved.filter((entry) => !isCommandEveManagedImageMcp(entry));
}
