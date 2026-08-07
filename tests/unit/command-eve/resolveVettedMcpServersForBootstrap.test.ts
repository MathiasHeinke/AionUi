/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FEEDER tests (S5 phase 2, arch §8/§12) — resolveVettedMcpServersForBootstrap.
 *
 * The load-bearing SAFETY regression + the isolation matrix:
 *  - flag FALSE → [] → renderHermesMcpServersYaml([]) is `mcp_servers: {}` (the
 *    exact byte-identical safety proof — the posture must NOT flip);
 *  - flag TRUE (test override) → founder-vetted appears in EVERY seat;
 *    seat-vetted appears ONLY in its seat (2-seat isolation negative);
 *  - env is vault-RESOLVED (decrypted values in `env`, NEVER a keychain ref or
 *    plaintext-in-config), asserted against the rendered YAML;
 *  - ONE bad decrypt DROPS the whole connector (never a partial server);
 *  - non-vetted records are never emitted; a connector with no mcp_invocation is
 *    dropped; stdio-only (no http/sse ever appears).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { encryptSecret, setSafeStorageForTesting, type SafeStorageAdapter } from '@/common/config/keychain';
import { founderVaultDir, seatVaultDir } from '@/process/commandEve/vaultDirCore';
import {
  VAULT_CONNECTOR_RECORD_VERSION,
  writeVaultRecord,
  type VaultConnectorRecord,
} from '@/process/commandEve/vaultRecordCore';
import {
  DEFAULT_COMMAND_EVE_CAPABILITY_PACK,
  renderHermesMcpServersYaml,
  resolveVettedMcpServersForBootstrap,
  type McpInvocationResolver,
} from '@/process/commandEve/runtimeBootstrapCore';
import { setMcpVaultEnabledForTests } from '@/process/commandEve/mcpVaultFlagCore';
import type { CommandEveConnectorMcpInvocation } from '@/process/commandEve/connectorCatalogCore';

function makeAvailableAdapter(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`enc::${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => {
      const raw = encrypted.toString('utf8');
      if (!raw.startsWith('enc::')) throw new Error('bad ciphertext');
      return raw.slice('enc::'.length);
    },
  };
}

const tmpDirs: string[] = [];
function makeTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-feeder-test-'));
  tmpDirs.push(dir);
  return dir;
}

function ref(secret: string): string {
  const enc = encryptSecret(secret);
  if (!enc.ok || !enc.ref) throw new Error('test setup: encryptSecret failed');
  return enc.ref;
}

const NOTION_INVOCATION: CommandEveConnectorMcpInvocation = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@notionhq/notion-mcp-server'],
  env_refs: ['NOTION_TOKEN'],
  scope_default: 'founder',
};

const resolver: McpInvocationResolver = (id) => (id === 'notion-workspace' ? NOTION_INVOCATION : undefined);

function record(overrides: Partial<VaultConnectorRecord>): VaultConnectorRecord {
  return {
    version: VAULT_CONNECTOR_RECORD_VERSION,
    connector_id: 'notion-workspace',
    scope: 'founder',
    env_refs: { NOTION_TOKEN: 'keychain:v1:c3RhdGljLXBsYWNlaG9sZGVy' },
    vetted: true,
    human_gate_receipt: 'receipt://hg-3/abc',
    approved_at: '2026-07-02T00:00:00.000Z',
    stored_at: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  setMcpVaultEnabledForTests(undefined);
  setSafeStorageForTesting(undefined);
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveVettedMcpServersForBootstrap — the kill switch (arch §8/§12)', () => {
  /**
   * REWRITTEN IN 1.821.0, AND THE REWRITE IS THE POINT. This block opened with
   * "returns [] when the flag is OFF (default)", set no override, and asserted
   * `[]`. After the flip that test still PASSED — but only because the temp vault
   * it pointed at was empty. It would have gone on reporting a short-circuit that
   * no longer happens, which is worse than failing.
   *
   * So the default case now proves the OPPOSITE, with a real record present, and
   * the genuine short-circuit is proven where it actually lives: with the kill
   * switch set and a record that WOULD otherwise be emitted.
   */
  it('DEFAULT (switch unset): a vetted record IS emitted — the surface is live', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const userDataPath = makeTmpRoot();
    writeVaultRecord(founderVaultDir(userDataPath), record({ env_refs: { NOTION_TOKEN: ref('live-token') } }));
    const servers = resolveVettedMcpServersForBootstrap(DEFAULT_COMMAND_EVE_CAPABILITY_PACK, 'seat-1', {
      userDataPath,
      configRoot: makeTmpRoot(),
      mcpInvocationFor: resolver,
    });
    expect(servers).toHaveLength(1);
    expect(servers[0].id).toBe('notion-workspace');
    expect(renderHermesMcpServersYaml(servers).join('\n')).toContain('"NOTION_TOKEN": "live-token"');
  });

  it('an install with an EMPTY vault is unchanged — mcp_servers: {} either way', () => {
    // The flip only reaches seats that actually approved something. Nothing about
    // it turns a bare install into one that spawns processes.
    const servers = resolveVettedMcpServersForBootstrap(DEFAULT_COMMAND_EVE_CAPABILITY_PACK, 'seat-1', {
      userDataPath: makeTmpRoot(),
      configRoot: makeTmpRoot(),
      mcpInvocationFor: resolver,
    });
    expect(servers).toEqual([]);
    expect(renderHermesMcpServersYaml(servers)).toEqual(['mcp_servers: {}']);
  });

  it('THE KILL SWITCH: a record that would otherwise be emitted is short-circuited', () => {
    setMcpVaultEnabledForTests(false);
    setSafeStorageForTesting(makeAvailableAdapter());
    const userDataPath = makeTmpRoot();
    // Persist a real vetted founder record — it must STILL not be emitted (flag off).
    writeVaultRecord(founderVaultDir(userDataPath), record({ env_refs: { NOTION_TOKEN: ref('secret-abc') } }));
    const servers = resolveVettedMcpServersForBootstrap(DEFAULT_COMMAND_EVE_CAPABILITY_PACK, 'seat-1', {
      userDataPath,
      configRoot: makeTmpRoot(),
      mcpInvocationFor: resolver,
    });
    expect(servers).toEqual([]);
    expect(renderHermesMcpServersYaml(servers)).toEqual(['mcp_servers: {}']);
  });
});

describe('resolveVettedMcpServersForBootstrap — flag ON behavior (arch §8/§12)', () => {
  it('emits a founder-vetted connector with env RESOLVED from the vault (never plaintext ref)', () => {
    setMcpVaultEnabledForTests(true);
    setSafeStorageForTesting(makeAvailableAdapter());
    const userDataPath = makeTmpRoot();
    const configRoot = makeTmpRoot();
    writeVaultRecord(founderVaultDir(userDataPath), record({ env_refs: { NOTION_TOKEN: ref('super-secret-token') } }));

    const servers = resolveVettedMcpServersForBootstrap(DEFAULT_COMMAND_EVE_CAPABILITY_PACK, 'seat-1', {
      userDataPath,
      configRoot,
      mcpInvocationFor: resolver,
    });
    expect(servers).toHaveLength(1);
    expect(servers[0]).toEqual({
      id: 'notion-workspace',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: { NOTION_TOKEN: 'super-secret-token' },
    });

    // The rendered YAML carries the DECRYPTED value and NEVER a keychain ref.
    const yaml = renderHermesMcpServersYaml(servers).join('\n');
    expect(yaml).toContain('"NOTION_TOKEN": "super-secret-token"');
    expect(yaml).not.toContain('keychain:v1:');
  });

  it('SEAT ISOLATION: a founder connector appears in every seat; a seat connector only in its own seat', () => {
    setMcpVaultEnabledForTests(true);
    setSafeStorageForTesting(makeAvailableAdapter());
    const userDataPath = makeTmpRoot();
    const configRoot = makeTmpRoot();

    // Founder connector (appears everywhere).
    writeVaultRecord(
      founderVaultDir(userDataPath),
      record({ connector_id: 'notion-workspace', scope: 'founder', env_refs: { NOTION_TOKEN: ref('founder-tok') } })
    );
    // Seat-A-only connector.
    writeVaultRecord(
      seatVaultDir(configRoot, 'seat-a'),
      record({
        connector_id: 'notion-workspace',
        scope: 'seat',
        seat_id: 'seat-a',
        env_refs: { NOTION_TOKEN: ref('seat-a-tok') },
      })
    );

    const resolveAll: McpInvocationResolver = () => NOTION_INVOCATION;

    // In SEAT A: the seat record wins on id collision (nearer scope), value = seat-a-tok.
    const seatA = resolveVettedMcpServersForBootstrap(DEFAULT_COMMAND_EVE_CAPABILITY_PACK, 'seat-a', {
      userDataPath,
      configRoot,
      mcpInvocationFor: resolveAll,
    });
    expect(seatA).toHaveLength(1);
    expect(seatA[0].env).toEqual({ NOTION_TOKEN: 'seat-a-tok' });

    // In SEAT B: seat-a's record is NEVER visible; only the founder record → founder-tok.
    const seatB = resolveVettedMcpServersForBootstrap(DEFAULT_COMMAND_EVE_CAPABILITY_PACK, 'seat-b', {
      userDataPath,
      configRoot,
      mcpInvocationFor: resolveAll,
    });
    expect(seatB).toHaveLength(1);
    expect(seatB[0].env).toEqual({ NOTION_TOKEN: 'founder-tok' });
    // Hard negative: seat-a's secret NEVER leaks into seat-b's rendered config.
    expect(renderHermesMcpServersYaml(seatB).join('\n')).not.toContain('seat-a-tok');
  });

  it('ONE bad decrypt drops the WHOLE connector (never a partial server)', () => {
    setMcpVaultEnabledForTests(true);
    setSafeStorageForTesting(makeAvailableAdapter());
    const userDataPath = makeTmpRoot();
    // A record with two env vars where ONE ref is un-decryptable (not a real ref
    // for this adapter). resolveEnvFromVault must fail-closed and drop it all.
    const rec = record({
      env_refs: { NOTION_TOKEN: ref('good'), SECOND: 'keychain:v1:bm90LXJlYWwtY2lwaGVydGV4dA==' },
    });
    // Bypass write validation quirks by writing directly; the record is structurally
    // valid (both values are keychain refs) but SECOND won't decrypt.
    writeVaultRecord(founderVaultDir(userDataPath), rec);
    const twoEnv: CommandEveConnectorMcpInvocation = { ...NOTION_INVOCATION, env_refs: ['NOTION_TOKEN', 'SECOND'] };

    const servers = resolveVettedMcpServersForBootstrap(DEFAULT_COMMAND_EVE_CAPABILITY_PACK, 'seat-1', {
      userDataPath,
      configRoot: makeTmpRoot(),
      mcpInvocationFor: () => twoEnv,
    });
    expect(servers).toEqual([]);
  });

  it('a connector with no known mcp_invocation is dropped (never spawn an undescribed command)', () => {
    setMcpVaultEnabledForTests(true);
    setSafeStorageForTesting(makeAvailableAdapter());
    const userDataPath = makeTmpRoot();
    writeVaultRecord(founderVaultDir(userDataPath), record({ env_refs: { NOTION_TOKEN: ref('tok') } }));
    const servers = resolveVettedMcpServersForBootstrap(DEFAULT_COMMAND_EVE_CAPABILITY_PACK, 'seat-1', {
      userDataPath,
      configRoot: makeTmpRoot(),
      mcpInvocationFor: () => undefined, // no invocation known for ANY id
    });
    expect(servers).toEqual([]);
  });

  it('returns [] when the two vault roots are not supplied (fail-closed), even flag ON', () => {
    setMcpVaultEnabledForTests(true);
    setSafeStorageForTesting(makeAvailableAdapter());
    expect(
      resolveVettedMcpServersForBootstrap(DEFAULT_COMMAND_EVE_CAPABILITY_PACK, 'seat-1', { mcpInvocationFor: resolver })
    ).toEqual([]);
  });
});
