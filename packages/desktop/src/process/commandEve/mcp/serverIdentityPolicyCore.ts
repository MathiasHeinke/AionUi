/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { BUILTIN_IMAGE_GEN_NAME } from '../../resources/builtinMcp/constants';

export const COMMAND_EVE_ARTIFACT_CONTEXT_MCP_ID = 'aionui-eve-artifacts';

const COMMAND_EVE_RESERVED_MCP_NAMESPACE = 'aionui-';

export type CommandEveMcpServerDescriptor = {
  id: string;
};

export type CommandEveMcpServerIdentityPolicyInput<TServer extends CommandEveMcpServerDescriptor> = {
  /** App-built image server. This slot is the provenance proof for its reserved id. */
  managedImage?: TServer;
  /** App-built artifact-context server. This slot is the provenance proof for its reserved id. */
  artifactContext?: TServer;
  /** Other app-owned servers such as the per-seat Honcho bridge. */
  appOwned?: readonly TServer[];
  /** HumanGate-approved connector-vault records. These never own the `aionui-*` namespace. */
  vettedExternal?: readonly TServer[];
};

export type CommandEveMcpServerIdentityPolicyReason =
  | 'COMMAND_EVE_MCP_SERVER_ID_REQUIRED'
  | 'COMMAND_EVE_MCP_BUILTIN_PROVENANCE_MISMATCH'
  | 'COMMAND_EVE_MCP_RESERVED_NAMESPACE_CLAIM'
  | 'COMMAND_EVE_MCP_DUPLICATE_ID';

export class CommandEveMcpServerIdentityPolicyError extends Error {
  readonly reasonCode: CommandEveMcpServerIdentityPolicyReason;
  readonly serverId: string;

  constructor(reasonCode: CommandEveMcpServerIdentityPolicyReason, serverId: string) {
    // The id may have come from an imported connector. Keep it available for
    // structured local diagnostics, but never interpolate it into a propagated
    // error string where control characters could forge a log or receipt line.
    super(reasonCode);
    this.name = 'CommandEveMcpServerIdentityPolicyError';
    this.reasonCode = reasonCode;
    this.serverId = serverId;
  }
}

type Candidate<TServer extends CommandEveMcpServerDescriptor> = {
  server: TServer;
  provenance: 'managed-image' | 'artifact-context' | 'app-owned' | 'vetted-external';
};

function assertBuiltinProvenance(candidate: Candidate<CommandEveMcpServerDescriptor>, expectedId: string): void {
  if (candidate.server.id.trim() !== expectedId) {
    throw new CommandEveMcpServerIdentityPolicyError(
      'COMMAND_EVE_MCP_BUILTIN_PROVENANCE_MISMATCH',
      candidate.server.id
    );
  }
}

/**
 * Compose the one MCP list that may be written to Hermes config.yaml.
 *
 * The input slots are deliberately provenance-bearing: an external record cannot
 * turn itself into a built-in by copying a reserved id. Every identity is checked
 * before any server is returned, so a collision aborts the whole composition
 * instead of silently replacing one YAML map entry with another.
 */
export function composeCommandEveHermesMcpServers<TServer extends CommandEveMcpServerDescriptor>(
  input: CommandEveMcpServerIdentityPolicyInput<TServer>
): TServer[] {
  const candidates: Candidate<TServer>[] = [
    ...(input.managedImage ? [{ server: input.managedImage, provenance: 'managed-image' as const }] : []),
    ...(input.artifactContext ? [{ server: input.artifactContext, provenance: 'artifact-context' as const }] : []),
    ...(input.appOwned ?? []).map((server) => ({ server, provenance: 'app-owned' as const })),
    ...(input.vettedExternal ?? []).map((server) => ({ server, provenance: 'vetted-external' as const })),
  ];

  if (input.managedImage) assertBuiltinProvenance(candidates[0], BUILTIN_IMAGE_GEN_NAME);
  if (input.artifactContext) {
    const artifactCandidate = candidates[input.managedImage ? 1 : 0];
    assertBuiltinProvenance(artifactCandidate, COMMAND_EVE_ARTIFACT_CONTEXT_MCP_ID);
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const id = candidate.server.id.trim();
    if (!id) {
      throw new CommandEveMcpServerIdentityPolicyError('COMMAND_EVE_MCP_SERVER_ID_REQUIRED', candidate.server.id);
    }
    const canonicalId = id.toLowerCase();
    if (
      (candidate.provenance === 'app-owned' || candidate.provenance === 'vetted-external') &&
      canonicalId.startsWith(COMMAND_EVE_RESERVED_MCP_NAMESPACE)
    ) {
      throw new CommandEveMcpServerIdentityPolicyError('COMMAND_EVE_MCP_RESERVED_NAMESPACE_CLAIM', id);
    }
    if (seen.has(canonicalId)) {
      throw new CommandEveMcpServerIdentityPolicyError('COMMAND_EVE_MCP_DUPLICATE_ID', id);
    }
    seen.add(canonicalId);
  }

  return candidates.map(({ server }) => server);
}
