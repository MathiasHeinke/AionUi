/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  evaluatePhaseAConvergence,
  PHASE_A_REQUIRED_GATE_IDS,
} from '@/process/commandEve/windows/phaseAConvergenceCore';
import type { WindowsGateId, WindowsGateReceiptV1 } from '@/process/commandEve/windows/types';

const COMMIT = 'a'.repeat(40);
const ARTIFACT_SHA = 'b'.repeat(64);

function receipt(gateId: WindowsGateId, overrides: Partial<WindowsGateReceiptV1> = {}): WindowsGateReceiptV1 {
  return {
    schema_version: 'command-eve-windows-gate/v1',
    gate_id: gateId,
    status: 'PASS',
    reject_code: null,
    source: { repository: 'command-eve-aionui', commit: COMMIT, tree_clean: true },
    artifact: {
      name: 'Command-EVE-1.7.92-win-x64.exe',
      sha256: ARTIFACT_SHA,
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
    commands: [],
    assertions: [{ id: `${gateId}-proof`, status: 'PASS', detail: `${gateId} passed` }],
    metrics: {},
    evidence_paths: [`reports/windows/phase-a/gates/${gateId}.json`],
    started_at: '2026-07-14T14:00:00.000Z',
    completed_at: '2026-07-14T14:01:00.000Z',
    worker: 'codex-runtime',
    reviewer: 'codex-controller',
    completion_sentinel: 'WIN_GATE_COMPLETE',
    ...overrides,
  };
}

function completeReceipts(): WindowsGateReceiptV1[] {
  return PHASE_A_REQUIRED_GATE_IDS.map((gateId) => receipt(gateId));
}

describe('Windows Phase A convergence', () => {
  it('passes only when every mandatory gate is bound to one clean commit and artifact', () => {
    expect(evaluatePhaseAConvergence(completeReceipts())).toEqual({
      ok: true,
      status: 'PASS',
      reject_code: null,
      source_commit: COMMIT,
      artifact_sha256: ARTIFACT_SHA,
      missing_gate_ids: [],
      errors: [],
      completion_sentinel: 'WIN_PHASE_A_CONVERGENCE_COMPLETE',
    });
  });

  it('rejects a missing minimal Hermes turn-holder gate', () => {
    const receipts = completeReceipts().filter((item) => item.gate_id !== 'WIN-G06T');
    const result = evaluatePhaseAConvergence(receipts);

    expect(result.ok).toBe(false);
    expect(result.reject_code).toBe('WIN_PHASE_A_REJECT');
    expect(result.missing_gate_ids).toEqual(['WIN-G06T']);
  });

  it.each(['WIN-G00', 'WIN-G01'] as const)('rejects missing frozen precondition gate %s', (gateId) => {
    const receipts = completeReceipts().filter((item) => item.gate_id !== gateId);
    const result = evaluatePhaseAConvergence(receipts);

    expect(result.ok).toBe(false);
    expect(result.missing_gate_ids).toEqual([gateId]);
  });

  it('rejects mixed candidate artifact hashes', () => {
    const receipts = completeReceipts().map((item) =>
      item.gate_id === 'WIN-G07'
        ? receipt('WIN-G07', { artifact: { ...item.artifact!, sha256: 'c'.repeat(64) } })
        : item
    );
    const result = evaluatePhaseAConvergence(receipts);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('mandatory gates reference multiple artifact SHA-256 values');
  });

  it('rejects duplicate gate receipts instead of choosing one implicitly', () => {
    const result = evaluatePhaseAConvergence([...completeReceipts(), receipt('WIN-G04')]);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('duplicate receipt for WIN-G04');
  });

  it('rejects blocked or malformed receipts even if all gate ids are present', () => {
    const receipts = completeReceipts().map((item) =>
      item.gate_id === 'WIN-G07'
        ? receipt('WIN-G07', { status: 'BLOCKED_AUTH', reject_code: 'WIN_CLOUD_CHAT_FAILED', artifact: null })
        : item
    );
    const result = evaluatePhaseAConvergence(receipts);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('WIN-G07 did not PASS');
  });

  it('rejects receipts from multiple source commits', () => {
    const receipts = completeReceipts().map((item) =>
      item.gate_id === 'WIN-G03'
        ? receipt('WIN-G03', {
            source: { repository: 'command-eve-aionui', commit: 'd'.repeat(40), tree_clean: true },
          })
        : item
    );
    const result = evaluatePhaseAConvergence(receipts);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('mandatory gates reference multiple source commits');
  });
});
