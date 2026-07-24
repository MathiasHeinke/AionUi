/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { BUILTIN_IMAGE_GEN_ID, BUILTIN_IMAGE_GEN_NAME, type IMcpServer } from '@/common/config/storage';

/**
 * EVE owns one safe, app-managed MCP default: image generation. Everything
 * else stays opt-in. The server still has to be enabled by the signed backend
 * bootstrap; this function never revives a disabled or user-authored server.
 */
export function resolveGuidInitialMcpServerIds(
  servers: readonly IMcpServer[],
  commandEveShellEnabled: boolean
): string[] {
  if (!commandEveShellEnabled) return [];
  return servers
    .filter(
      (server) =>
        server.enabled === true &&
        server.builtin === true &&
        (server.id === BUILTIN_IMAGE_GEN_ID || server.name === BUILTIN_IMAGE_GEN_NAME)
    )
    .map((server) => server.id);
}
