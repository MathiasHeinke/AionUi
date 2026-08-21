/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { CommandEveMcpServerIdentityPolicyError, composeCommandEveHermesMcpServers } from '@/process/commandEve/mcp';

type Server = { id: string; command: string };

const server = (id: string): Server => ({ id, command: `/managed/${id}` });

function expectPolicyReason(
  run: () => unknown,
  reasonCode: CommandEveMcpServerIdentityPolicyError['reasonCode']
): void {
  try {
    run();
    throw new Error('Expected MCP identity policy to reject the candidate set.');
  } catch (error) {
    expect(error).toBeInstanceOf(CommandEveMcpServerIdentityPolicyError);
    expect((error as CommandEveMcpServerIdentityPolicyError).reasonCode).toBe(reasonCode);
  }
}

describe('composeCommandEveHermesMcpServers reserved namespace policy', () => {
  it('accepts the two reserved ids only in their app-built provenance slots', () => {
    const managedImage = server('aionui-image-generation');
    const artifactContext = server('aionui-eve-artifacts');

    expect(composeCommandEveHermesMcpServers({ managedImage, artifactContext })).toEqual([
      managedImage,
      artifactContext,
    ]);
  });

  it('rejects an external connector that copies either reserved built-in id', () => {
    for (const id of ['aionui-image-generation', 'aionui-eve-artifacts']) {
      expectPolicyReason(
        () => composeCommandEveHermesMcpServers({ vettedExternal: [server(id)] }),
        'COMMAND_EVE_MCP_RESERVED_NAMESPACE_CLAIM'
      );
    }
  });

  it('rejects every other external claim under the reserved aionui namespace', () => {
    expectPolicyReason(
      () => composeCommandEveHermesMcpServers({ vettedExternal: [server('AIONUI-browser-shadow')] }),
      'COMMAND_EVE_MCP_RESERVED_NAMESPACE_CLAIM'
    );
  });

  it('rejects a reserved id in the wrong app-owned provenance slot', () => {
    expectPolicyReason(
      () => composeCommandEveHermesMcpServers({ managedImage: server('aionui-eve-artifacts') }),
      'COMMAND_EVE_MCP_BUILTIN_PROVENANCE_MISMATCH'
    );
  });

  it('rejects a generic app-owned server that claims the reserved namespace', () => {
    expectPolicyReason(
      () => composeCommandEveHermesMcpServers({ appOwned: [server('aionui-unattested-helper')] }),
      'COMMAND_EVE_MCP_RESERVED_NAMESPACE_CLAIM'
    );
  });
});
