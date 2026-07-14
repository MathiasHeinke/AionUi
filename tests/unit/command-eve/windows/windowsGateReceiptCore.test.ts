/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  validateWindowsGateReceipt,
  type WindowsGateReceiptV1,
} from '@/process/commandEve/windows/windowsGateReceiptCore';

function receipt(overrides: Partial<WindowsGateReceiptV1> = {}): WindowsGateReceiptV1 {
  return {
    schema_version: 'command-eve-windows-gate/v1',
    gate_id: 'WIN-G04',
    status: 'PASS',
    reject_code: null,
    source: {
      repository: 'command-eve-aionui',
      commit: 'a'.repeat(40),
      tree_clean: true,
    },
    artifact: {
      name: 'Command-EVE-1.7.92-win-x64.exe',
      sha256: 'b'.repeat(64),
      signed: false,
      signature_subject: null,
    },
    environment: {
      os: 'Windows 11',
      os_build: '20348.2527',
      arch: 'x64',
      ram_bytes: 16 * 1024 ** 3,
      cpu_count: 4,
      test_mode: 'packaged-release',
    },
    commands: [{ command: 'bun run build:win:x64', exit_code: 0, duration_ms: 1_000 }],
    assertions: [{ id: 'installer-present', status: 'PASS', detail: 'NSIS artifact exists' }],
    metrics: { artifact_count: 3 },
    evidence_paths: ['reports/windows/phase-a/gates/WIN-G04.json'],
    started_at: '2026-07-14T14:00:00.000Z',
    completed_at: '2026-07-14T14:01:00.000Z',
    worker: 'codex-runtime',
    reviewer: 'codex-controller',
    completion_sentinel: 'WIN_GATE_COMPLETE',
    ...overrides,
  };
}

describe('Windows gate receipt validation', () => {
  it('accepts a complete unsigned Phase A receipt', () => {
    expect(validateWindowsGateReceipt(receipt())).toEqual({ ok: true, errors: [] });
  });

  it('rejects a PASS receipt from a dirty source tree', () => {
    const result = validateWindowsGateReceipt(
      receipt({ source: { repository: 'command-eve-aionui', commit: 'a'.repeat(40), tree_clean: false } })
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('source.tree_clean must be true for PASS');
  });

  it('rejects malformed commits and artifact hashes', () => {
    const result = validateWindowsGateReceipt(
      receipt({
        source: { repository: 'command-eve-aionui', commit: 'not-a-commit', tree_clean: true },
        artifact: {
          name: 'Command-EVE.exe',
          sha256: 'not-a-sha',
          signed: false,
          signature_subject: null,
        },
      })
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('source.commit must be a 40-character lowercase SHA-1');
    expect(result.errors).toContain('artifact.sha256 must be a 64-character lowercase SHA-256');
  });

  it('rejects absolute and parent-traversing evidence paths', () => {
    const result = validateWindowsGateReceipt(
      receipt({ evidence_paths: ['C:\\Users\\operator\\private.log', '../private/receipt.json'] })
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('evidence_paths[0] must be repository-relative');
    expect(result.errors).toContain('evidence_paths[1] must be repository-relative');
  });

  it('requires a reject code when a gate does not pass', () => {
    const result = validateWindowsGateReceipt(receipt({ status: 'BLOCKED_AUTH', reject_code: null, artifact: null }));

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('reject_code is required unless status is PASS');
  });

  it('rejects signed artifacts in the unsigned Phase A receipt class', () => {
    const result = validateWindowsGateReceipt(
      receipt({
        artifact: {
          name: 'Command-EVE.exe',
          sha256: 'b'.repeat(64),
          signed: true,
          signature_subject: 'CN=Unexpected Publisher',
        },
      })
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('artifact.signed must be false for an unsigned Phase A receipt');
  });

  it('fails closed for non-object input instead of throwing', () => {
    expect(validateWindowsGateReceipt('PASS')).toEqual({
      ok: false,
      errors: ['receipt must be an object'],
    });
  });
});
