/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * guided_auth_setup tests (S5 phase 2, arch §6/§12): API-key path, fail-closed.
 *  - keychain unavailable → REFUSE (SECURE_STORAGE_UNAVAILABLE), NO record written,
 *    NO plaintext anywhere;
 *  - a receipt is REQUIRED for a vetted record (rejected before any encrypt);
 *  - the API key is ENCRYPTED into a keychain ref; the plaintext is never in the
 *    return NOR in the persisted record (only refs on disk);
 *  - env-name mismatch / missing invocation → reject;
 *  - founder scope writes to the founder dir; seat scope writes to the seat dir;
 *  - an unsanitizable seat id → reject (no path traversal).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { setSafeStorageForTesting, type SafeStorageAdapter } from '@/common/config/keychain';
import { founderVaultDir, seatVaultDir } from '@/process/commandEve/vaultDirCore';
import { listVaultRecords } from '@/process/commandEve/vaultRecordCore';
import { runGuidedApiKeySetup } from '@/process/commandEve/guidedAuthSetupCore';
import type { CommandEveConnectorMcpInvocation } from '@/process/commandEve/connectorCatalogCore';

function makeAvailableAdapter(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`enc::${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8').replace(/^enc::/, ''),
  };
}

const tmpDirs: string[] = [];
function makeTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-guided-auth-test-'));
  tmpDirs.push(dir);
  return dir;
}

const NOTION_INVOCATION: CommandEveConnectorMcpInvocation = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@notionhq/notion-mcp-server'],
  env_refs: ['NOTION_TOKEN'],
  scope_default: 'founder',
};

afterEach(() => {
  setSafeStorageForTesting(undefined);
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('runGuidedApiKeySetup — keychain fail-closed FIRST (arch §6.2/§11.1)', () => {
  it('REFUSES when secure storage is unavailable and writes NO record + NO plaintext', () => {
    setSafeStorageForTesting(null); // no encryption backend
    const userDataPath = makeTmpRoot();
    const result = runGuidedApiKeySetup({
      connector_id: 'notion-workspace',
      mcp_invocation: NOTION_INVOCATION,
      secrets: { NOTION_TOKEN: 'plaintext-should-never-land' },
      scope: 'founder',
      human_gate_receipt: 'receipt://hg-3/x',
      userDataPath,
    });
    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe('SECURE_STORAGE_UNAVAILABLE');
    // No record on disk.
    expect(listVaultRecords(founderVaultDir(userDataPath))).toEqual([]);
    // No plaintext escaped into the result object.
    expect(JSON.stringify(result)).not.toContain('plaintext-should-never-land');
  });
});

describe('runGuidedApiKeySetup — HumanGate receipt required (arch §11.3)', () => {
  it('rejects a vetted setup with an empty receipt, BEFORE any encrypt/write', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const userDataPath = makeTmpRoot();
    const result = runGuidedApiKeySetup({
      connector_id: 'notion-workspace',
      mcp_invocation: NOTION_INVOCATION,
      secrets: { NOTION_TOKEN: 'tok' },
      scope: 'founder',
      human_gate_receipt: '   ',
      userDataPath,
    });
    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe('GUIDED_AUTH_HUMANGATE_RECEIPT_REQUIRED');
    expect(listVaultRecords(founderVaultDir(userDataPath))).toEqual([]);
  });
});

describe('runGuidedApiKeySetup — happy path encrypts, never persists plaintext', () => {
  it('writes a vetted founder record whose env value is a keychain ref (not plaintext)', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const userDataPath = makeTmpRoot();
    const result = runGuidedApiKeySetup({
      connector_id: 'notion-workspace',
      mcp_invocation: NOTION_INVOCATION,
      secrets: { NOTION_TOKEN: 'ntn_super_secret' },
      scope: 'founder',
      human_gate_receipt: 'receipt://hg-3/abc',
      userDataPath,
    });
    expect(result.ok).toBe(true);
    expect(result.path).toBeTruthy();
    // The persisted file must NOT contain the plaintext, only a keychain ref.
    const onDisk = fs.readFileSync(result.path as string, 'utf8');
    expect(onDisk).not.toContain('ntn_super_secret');
    expect(onDisk).toContain('keychain:v1:');
    const records = listVaultRecords(founderVaultDir(userDataPath));
    expect(records).toHaveLength(1);
    expect(records[0].vetted).toBe(true);
    expect(records[0].human_gate_receipt).toBe('receipt://hg-3/abc');
    expect(records[0].env_refs.NOTION_TOKEN.startsWith('keychain:v1:')).toBe(true);
  });

  it('SEAT scope writes to the seat dir, not the founder dir', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const userDataPath = makeTmpRoot();
    const configRoot = makeTmpRoot();
    const result = runGuidedApiKeySetup({
      connector_id: 'notion-workspace',
      mcp_invocation: NOTION_INVOCATION,
      secrets: { NOTION_TOKEN: 'client-key' },
      scope: 'seat',
      seat_id: 'seat-a',
      human_gate_receipt: 'receipt://hg-3/seat',
      userDataPath,
      configRoot,
    });
    expect(result.ok).toBe(true);
    expect(listVaultRecords(seatVaultDir(configRoot, 'seat-a'))).toHaveLength(1);
    // Founder dir stays empty (isolation: a client key never lands in the founder vault).
    expect(listVaultRecords(founderVaultDir(userDataPath))).toEqual([]);
  });

  it('rejects an unsanitizable seat id (path-traversal guard)', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const result = runGuidedApiKeySetup({
      connector_id: 'notion-workspace',
      mcp_invocation: NOTION_INVOCATION,
      secrets: { NOTION_TOKEN: 'k' },
      scope: 'seat',
      seat_id: '../../escape',
      human_gate_receipt: 'receipt://hg-3/x',
      userDataPath: makeTmpRoot(),
      configRoot: makeTmpRoot(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe('GUIDED_AUTH_SEAT_ID_UNSAFE');
  });
});

describe('runGuidedApiKeySetup — env / invocation guards', () => {
  it('rejects a missing mcp_invocation (OAuth-only / not wired)', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const result = runGuidedApiKeySetup({
      connector_id: 'notion-workspace',
      mcp_invocation: undefined,
      secrets: { NOTION_TOKEN: 'k' },
      scope: 'founder',
      human_gate_receipt: 'receipt://hg-3/x',
      userDataPath: makeTmpRoot(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe('GUIDED_AUTH_NO_MCP_INVOCATION');
  });

  it('rejects an env-name mismatch (extra or missing keys → no partial connector)', () => {
    setSafeStorageForTesting(makeAvailableAdapter());
    const result = runGuidedApiKeySetup({
      connector_id: 'notion-workspace',
      mcp_invocation: NOTION_INVOCATION,
      secrets: { WRONG_NAME: 'k' },
      scope: 'founder',
      human_gate_receipt: 'receipt://hg-3/x',
      userDataPath: makeTmpRoot(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe('GUIDED_AUTH_ENV_MISMATCH');
  });
});
