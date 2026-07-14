/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WindowsGateId, WindowsGateReceiptV1 } from './types';
import { validateWindowsGateReceipt } from './windowsGateReceiptCore';

export const PHASE_A_REQUIRED_GATE_IDS = [
  'WIN-G02',
  'WIN-G03',
  'WIN-G04',
  'WIN-G05',
  'WIN-G06',
  'WIN-G06T',
  'WIN-G07',
] as const satisfies readonly WindowsGateId[];

const PHASE_A_ARTIFACT_BOUND_GATE_IDS = new Set<WindowsGateId>([
  'WIN-G04',
  'WIN-G05',
  'WIN-G06',
  'WIN-G06T',
  'WIN-G07',
]);

export type PhaseAConvergenceResult = {
  ok: boolean;
  status: 'PASS' | 'REJECT';
  reject_code: 'WIN_PHASE_A_REJECT' | null;
  source_commit: string | null;
  artifact_sha256: string | null;
  missing_gate_ids: WindowsGateId[];
  errors: string[];
  completion_sentinel: 'WIN_PHASE_A_CONVERGENCE_COMPLETE';
};

export function evaluatePhaseAConvergence(receipts: WindowsGateReceiptV1[]): PhaseAConvergenceResult {
  const errors: string[] = [];
  const byGateId = new Map<WindowsGateId, WindowsGateReceiptV1>();

  for (const receipt of receipts) {
    if (byGateId.has(receipt.gate_id)) {
      errors.push(`duplicate receipt for ${receipt.gate_id}`);
      continue;
    }
    byGateId.set(receipt.gate_id, receipt);

    const validation = validateWindowsGateReceipt(receipt);
    for (const error of validation.errors) errors.push(`${receipt.gate_id}: ${error}`);
  }

  const missingGateIds = PHASE_A_REQUIRED_GATE_IDS.filter((gateId) => !byGateId.has(gateId));
  const mandatoryReceipts = PHASE_A_REQUIRED_GATE_IDS.flatMap((gateId) => {
    const receipt = byGateId.get(gateId);
    return receipt ? [receipt] : [];
  });

  for (const receipt of mandatoryReceipts) {
    if (receipt.status !== 'PASS') errors.push(`${receipt.gate_id} did not PASS`);
  }

  const sourceCommits = new Set(mandatoryReceipts.map((receipt) => receipt.source.commit));
  if (sourceCommits.size > 1) errors.push('mandatory gates reference multiple source commits');

  const artifactHashes = new Set(
    mandatoryReceipts
      .filter((receipt) => PHASE_A_ARTIFACT_BOUND_GATE_IDS.has(receipt.gate_id))
      .flatMap((receipt) => (receipt.artifact ? [receipt.artifact.sha256] : []))
  );
  if (artifactHashes.size > 1) errors.push('mandatory gates reference multiple artifact SHA-256 values');

  const ok =
    errors.length === 0 && missingGateIds.length === 0 && sourceCommits.size === 1 && artifactHashes.size === 1;
  return {
    ok,
    status: ok ? 'PASS' : 'REJECT',
    reject_code: ok ? null : 'WIN_PHASE_A_REJECT',
    source_commit: sourceCommits.size === 1 ? [...sourceCommits][0] : null,
    artifact_sha256: artifactHashes.size === 1 ? [...artifactHashes][0] : null,
    missing_gate_ids: [...missingGateIds],
    errors,
    completion_sentinel: 'WIN_PHASE_A_CONVERGENCE_COMPLETE',
  };
}
