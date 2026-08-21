/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  composeCommandEveHermesMcpServers,
  type CommandEveMcpServerIdentityPolicyError,
} from '@/process/commandEve/mcp';

type Server = { id: string; command: string; env?: Record<string, string> };

const server = (id: string): Server => ({ id, command: `/managed/${id}` });

describe('Command EVE Hermes MCP bootstrap composition contract', () => {
  it('preserves the deterministic built-in, app-owned, external order', () => {
    const servers = composeCommandEveHermesMcpServers({
      managedImage: server('aionui-image-generation'),
      artifactContext: server('aionui-eve-artifacts'),
      appOwned: [server('honcho-seat-1')],
      vettedExternal: [server('notion-workspace'), server('supabase-project')],
    });

    expect(servers.map(({ id }) => id)).toEqual([
      'aionui-image-generation',
      'aionui-eve-artifacts',
      'honcho-seat-1',
      'notion-workspace',
      'supabase-project',
    ]);
  });

  it('fails the whole composition for duplicate ids instead of emitting an ambiguous YAML map', () => {
    expect(() =>
      composeCommandEveHermesMcpServers({
        appOwned: [server('honcho-seat-1')],
        vettedExternal: [server('honcho-seat-1')],
      })
    ).toThrowError(
      expect.objectContaining<Partial<CommandEveMcpServerIdentityPolicyError>>({
        reasonCode: 'COMMAND_EVE_MCP_DUPLICATE_ID',
      })
    );
  });

  it('treats case-only duplicates as one identity', () => {
    expect(() =>
      composeCommandEveHermesMcpServers({
        vettedExternal: [server('notion-workspace'), server('NOTION-WORKSPACE')],
      })
    ).toThrowError(
      expect.objectContaining<Partial<CommandEveMcpServerIdentityPolicyError>>({
        reasonCode: 'COMMAND_EVE_MCP_DUPLICATE_ID',
      })
    );
  });

  it('rejects a blank id before returning any server', () => {
    expect(() =>
      composeCommandEveHermesMcpServers({ vettedExternal: [server('valid-first'), server('   ')] })
    ).toThrowError(
      expect.objectContaining<Partial<CommandEveMcpServerIdentityPolicyError>>({
        reasonCode: 'COMMAND_EVE_MCP_SERVER_ID_REQUIRED',
      })
    );
  });

  it('does not mutate the caller-owned arrays or server descriptors', () => {
    const external = [server('notion-workspace')];
    const result = composeCommandEveHermesMcpServers({ vettedExternal: external });
    external.push(server('added-after-composition'));

    expect(result.map(({ id }) => id)).toEqual(['notion-workspace']);
    expect(result[0]).toBe(external[0]);
  });
});
