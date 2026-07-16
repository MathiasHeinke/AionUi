/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  evaluatePhaseBCandidateConvergence,
  PHASE_B_GATE_CONTRACTS,
  PHASE_B_REQUIRED_RECEIPTS,
  phaseBGateEvaluation,
  validatePhaseBCandidateManifest,
  validatePhaseBGateReceipt,
  type PhaseBCandidateConvergenceOptions,
  type PhaseBCandidateManifestV1,
  type PhaseBGateExecution,
  type PhaseBGateId,
  type PhaseBGateProvenance,
  type PhaseBGateReceiptV1,
  type PhaseBGateTarget,
} from '@/process/commandEve/windows/phaseBCandidateConvergenceCore';
import {
  evaluatePhaseBRawGate,
  PHASE_B_PERFORMANCE_THRESHOLDS,
  PHASE_B_RAW_EVALUATION_SCHEMA_VERSION,
  type PhaseBRawGateEvaluationV1,
} from '@/process/commandEve/windows/phaseBGateEvaluatorCore';

const SOURCE_COMMIT = 'a'.repeat(40);
const ARTIFACT_SHA256 = 'b'.repeat(64);
const MANIFEST_SHA256 = 'd'.repeat(64);
const EVIDENCE_SHA256 = 'c'.repeat(64);
const MACHINE_RECEIPT_SHA256 = 'f'.repeat(64);
const MAC_RECEIPT_SHA256 = '1'.repeat(64);
const WINDOWS_RECEIPT_SHA256 = '2'.repeat(64);
const CONTROLLER_REPORT_SHA256 = '3'.repeat(64);
const ARTIFACT_SIZE = 1_024;
const MANIFEST: PhaseBCandidateManifestV1 = {
  schema_version: 'command-eve-windows-phase-b-candidate/v1',
  candidate_id: `ceve-win-${'a'.repeat(12)}-${'b'.repeat(12)}`,
  source: { repository: 'MathiasHeinke/AionUi', commit: SOURCE_COMMIT, tree_clean: true },
  artifact: { name: 'Command EVE-1.8.14-win-x64.exe', sha256: ARTIFACT_SHA256, size_bytes: ARTIFACT_SIZE },
  build: {
    workflow_repository: 'MathiasHeinke/AionUi',
    workflow_commit: SOURCE_COMMIT,
    run_id: '123456789',
    run_attempt: 1,
    job: 'windows-phase-b-candidate',
    runner_os: 'Windows',
    runner_arch: 'X64',
  },
  created_at: '2026-07-15T18:00:00.000Z',
  completion_sentinel: 'WIN_PHASE_B_CANDIDATE_MANIFEST_COMPLETE',
};

function execution(target: PhaseBGateTarget): PhaseBGateExecution {
  if (target === 'lowmem-8gb' || target === 'normal-16gb') {
    return {
      target,
      os_name: 'Microsoft Windows 11 Enterprise',
      os_build: '26100',
      native_architecture: 'AMD64',
      process_architecture: 'X64',
      ram_bytes: (target === 'lowmem-8gb' ? 8 : 16) * 1024 ** 3,
      cpu_count: target === 'lowmem-8gb' ? 2 : 4,
      standard_user: true,
    };
  }
  if (target === 'cross-platform') {
    return { target, platforms: ['macOS', 'Windows'], same_source_commit: true };
  }
  return { target, controller: 'codex-controller' };
}

function provenance(target: PhaseBGateTarget): PhaseBGateProvenance {
  if (target === 'lowmem-8gb' || target === 'normal-16gb') {
    const memory = target === 'lowmem-8gb' ? 'lowmem' : 'normal';
    return {
      lane: 'windows-cloud-pc',
      workflow_repository: 'MathiasHeinke/command-eve-windows-lab',
      workflow_commit: SOURCE_COMMIT,
      run_id: '123456789',
      run_attempt: 1,
      job: `phase-b-${target}`,
      runner_binding: 'e'.repeat(32),
      runner_name: `command-eve-phase-b-${memory}-${'e'.repeat(12)}`,
      machine_receipt_sha256: MACHINE_RECEIPT_SHA256,
    };
  }
  if (target === 'cross-platform') {
    return {
      lane: 'cross-platform-ci',
      workflow_repository: 'MathiasHeinke/AionUi',
      workflow_commit: SOURCE_COMMIT,
      run_id: '123456789',
      run_attempt: 1,
      job: 'phase-b-parity',
      mac_receipt_sha256: MAC_RECEIPT_SHA256,
      windows_receipt_sha256: WINDOWS_RECEIPT_SHA256,
    };
  }
  return {
    lane: 'controller-review',
    controller: 'codex-controller',
    source_tree_clean: true,
    report_sha256: CONTROLLER_REPORT_SHA256,
  };
}

function receipt(
  gateId: PhaseBGateId,
  target: PhaseBGateTarget,
  overrides: Partial<PhaseBGateReceiptV1> = {}
): PhaseBGateReceiptV1 {
  const contract = PHASE_B_GATE_CONTRACTS[gateId];
  const evidence = contract.required_evidence_kinds.map((kind, index) => ({
    path: `raw/${gateId}/${target}/${index}-${kind}.bin`,
    sha256: EVIDENCE_SHA256,
    size_bytes: 8,
    kind,
  }));
  if (target === 'lowmem-8gb' || target === 'normal-16gb') {
    evidence.push({
      path: `raw/${gateId}/${target}/provenance-machine-receipt.json`,
      sha256: MACHINE_RECEIPT_SHA256,
      size_bytes: 8,
      kind: 'json',
    });
  } else if (target === 'cross-platform') {
    evidence.push(
      {
        path: `raw/${gateId}/${target}/provenance-mac-receipt.json`,
        sha256: MAC_RECEIPT_SHA256,
        size_bytes: 8,
        kind: 'json',
      },
      {
        path: `raw/${gateId}/${target}/provenance-windows-receipt.json`,
        sha256: WINDOWS_RECEIPT_SHA256,
        size_bytes: 8,
        kind: 'json',
      }
    );
  } else {
    evidence.push({
      path: `raw/${gateId}/${target}/provenance-controller-report.md`,
      sha256: CONTROLLER_REPORT_SHA256,
      size_bytes: 8,
      kind: 'report',
    });
  }
  const commandId = `${gateId.toLowerCase()}-${target}`;
  const observations: PhaseBRawGateEvaluationV1['observations'] = Object.fromEntries(
    contract.required_assertion_ids.map((id) => [
      id,
      {
        command_id: commandId,
        evidence_paths: evidence.map((item) => item.path),
        completion_sentinel: 'WIN_PHASE_B_ASSERTION_PROOF_COMPLETE',
      },
    ])
  );
  if (gateId === 'WIN-B08') observations.stop_acknowledged_p95_ms = 100;
  if (gateId === 'WIN-B09') {
    observations.process_tree_cleanup_ms = 250;
    observations.orphan_count = 0;
  }
  if (gateId === 'WIN-B12') {
    observations.ui_heartbeat_max_gap_ms = 500;
    observations.freeze_count = 0;
    observations.idle_process_tree_rss_bytes = PHASE_B_PERFORMANCE_THRESHOLDS.lowmemIdleProcessTreeRssBytes;
    observations.oom_count = 0;
    observations.idle_cpu_median_percent = 2;
    observations.degraded_profile_active = true;
    observations.local_inference_disabled = true;
    observations.worker_concurrency = 1;
  }
  if (gateId === 'WIN-B13') {
    observations.warm_visible_window_p95_ms = 4_000;
    observations.chat_first_response_p95_ms = 20_000;
    observations.artifact_visible_p95_ms = 40_000;
    observations.worker_completion_p95_ms = 90_000;
  }
  if (gateId === 'WIN-B14') {
    observations.soak_duration_ms = PHASE_B_PERFORMANCE_THRESHOLDS.soakDurationMs;
    observations.sample_count = PHASE_B_PERFORMANCE_THRESHOLDS.soakMinimumSamples;
    observations.rss_growth_percent = 10;
    observations.deadlock_count = 0;
    observations.orphan_growth_count = 0;
  }
  if (gateId === 'WIN-B18') {
    observations.unresolved_p0 = 0;
    observations.unresolved_p1 = 0;
    observations.unresolved_p2 = 0;
  }
  const evaluationOutcome = overrides.evaluation_outcome ?? 'completed';
  const raw: PhaseBRawGateEvaluationV1 = {
    schema_version: PHASE_B_RAW_EVALUATION_SCHEMA_VERSION,
    gate_id: gateId,
    evaluation_outcome: evaluationOutcome,
    execution: execution(target),
    provenance: provenance(target),
    commands: [{ id: commandId, exit_code: 0, duration_ms: 1_000 }],
    observations,
    metrics: { check_count: contract.required_assertion_ids.length },
    evidence: evidence.map((item) => ({ path: item.path, kind: item.kind })),
    started_at: '2026-07-15T18:00:00.000Z',
    completed_at: '2026-07-15T18:01:00.000Z',
    worker: 'windows-phase-b-runner',
    reviewer: 'codex-controller',
    completion_sentinel: 'WIN_PHASE_B_RAW_EVALUATION_COMPLETE',
  };
  const derived = evaluatePhaseBRawGate(raw);
  return {
    schema_version: 'command-eve-windows-phase-b-gate/v1',
    candidate_id: MANIFEST.candidate_id,
    candidate_manifest_sha256: MANIFEST_SHA256,
    gate_id: gateId,
    ...phaseBGateEvaluation(gateId, evaluationOutcome, derived.assertions),
    evaluation_outcome: evaluationOutcome,
    source: MANIFEST.source,
    artifact: MANIFEST.artifact,
    execution: execution(target),
    provenance: provenance(target),
    commands: raw.commands,
    assertions: derived.assertions,
    metrics: raw.metrics,
    evidence,
    raw_evaluation: {
      schema_version: raw.schema_version,
      observations: raw.observations,
      completion_sentinel: raw.completion_sentinel,
    },
    started_at: '2026-07-15T18:00:00.000Z',
    completed_at: '2026-07-15T18:01:00.000Z',
    worker: 'windows-phase-b-runner',
    reviewer: 'codex-controller',
    completion_sentinel: 'WIN_PHASE_B_GATE_COMPLETE',
    ...overrides,
  };
}

function completeMatrix(): PhaseBGateReceiptV1[] {
  return PHASE_B_REQUIRED_RECEIPTS.map(({ gate_id, target }) => receipt(gate_id, target));
}

function optionsFor(receipts: readonly PhaseBGateReceiptV1[]): PhaseBCandidateConvergenceOptions {
  return {
    candidate_manifest: MANIFEST,
    candidate_manifest_sha256: MANIFEST_SHA256,
    evidence_files: Object.fromEntries(
      receipts.flatMap((item) =>
        item.evidence.map((evidence) => [evidence.path, { sha256: evidence.sha256, size_bytes: evidence.size_bytes }])
      )
    ),
  };
}

describe('Windows Phase B candidate convergence', () => {
  it('accepts the exact 26-receipt matrix on one immutable candidate and verified evidence bundle', () => {
    const receipts = completeMatrix();
    const result = evaluatePhaseBCandidateConvergence(receipts, optionsFor(receipts));

    expect(PHASE_B_REQUIRED_RECEIPTS).toHaveLength(26);
    expect(result).toMatchObject({
      status: 'PASS',
      reject_code: null,
      candidate_id: MANIFEST.candidate_id,
      source_commit: SOURCE_COMMIT,
      artifact_sha256: ARTIFACT_SHA256,
      artifact_name: MANIFEST.artifact.name,
      required_receipt_count: 26,
      accepted_receipt_count: 26,
      missing_receipts: [],
      errors: [],
      completion_sentinel: 'WIN_PHASE_B_INTERNAL_PRESENTATION_CONVERGENCE_COMPLETE',
    });
  });

  it('fails closed when one target receipt is missing', () => {
    const receipts = completeMatrix().filter(
      (item) => !(item.gate_id === 'WIN-B12' && item.execution.target === 'lowmem-8gb')
    );
    const result = evaluatePhaseBCandidateConvergence(receipts, optionsFor(receipts));

    expect(result.status).toBe('REJECT');
    expect(result.missing_receipts).toEqual(['WIN-B12@lowmem-8gb']);
  });

  it('rejects malformed untrusted receipt values without throwing', () => {
    const result = evaluatePhaseBCandidateConvergence([null, {}], optionsFor([]));

    expect(result.status).toBe('REJECT');
    expect(result.accepted_receipt_count).toBe(1);
    expect(result.errors).toContain('receipt[0]: receipt must be an object');
    expect(result.errors).toContain('undefined@unknown: candidate_id is required');
  });

  it('rejects duplicate and unexpected gate-target receipts', () => {
    const receipts = completeMatrix();
    receipts.push(receipt('WIN-B12', 'lowmem-8gb'));
    receipts.push(receipt('WIN-B12', 'normal-16gb'));
    const result = evaluatePhaseBCandidateConvergence(receipts, optionsFor(receipts));

    expect(result.status).toBe('REJECT');
    expect(result.errors).toContain('duplicate receipt for WIN-B12@lowmem-8gb');
    expect(result.errors).toContain(
      'WIN-B12@normal-16gb: WIN-B12@normal-16gb is not part of the required Phase B matrix'
    );
    expect(result.errors).toContain('unexpected receipt WIN-B12@normal-16gb');
  });

  it('rejects source, candidate-manifest, artifact and evidence drift', () => {
    const receipts = completeMatrix();
    receipts[0] = receipt('WIN-B00', 'lowmem-8gb', {
      candidate_manifest_sha256: '9'.repeat(64),
      source: { repository: 'MathiasHeinke/AionUi', commit: '4'.repeat(40), tree_clean: true },
      artifact: { name: 'Command EVE-other-win-x64.exe', sha256: '5'.repeat(64), size_bytes: 99 },
      evidence: [{ ...receipt('WIN-B00', 'lowmem-8gb').evidence[0], sha256: '6'.repeat(64) }],
    });
    const result = evaluatePhaseBCandidateConvergence(receipts, optionsFor(completeMatrix()));

    expect(result.status).toBe('REJECT');
    expect(result.errors).toContain('WIN-B00@lowmem-8gb references an unexpected candidate manifest SHA-256');
    expect(result.errors).toContain('WIN-B00@lowmem-8gb references an unexpected source commit');
    expect(result.errors).toContain('WIN-B00@lowmem-8gb references an unexpected artifact name');
    expect(result.errors).toContain('WIN-B00@lowmem-8gb evidence SHA-256 mismatch: raw/WIN-B00/lowmem-8gb/0-json.bin');
  });

  it('accepts a structurally valid blocked receipt as evidence but never as convergence', () => {
    const blocked = receipt('WIN-B03', 'normal-16gb', {
      evaluation_outcome: 'blocked-auth',
      evidence: [],
    });

    expect(validatePhaseBGateReceipt(blocked)).toEqual({ ok: true, errors: [] });
    const receipts = completeMatrix();
    receipts[PHASE_B_REQUIRED_RECEIPTS.findIndex((item) => item.gate_id === 'WIN-B03')] = blocked;
    expect(evaluatePhaseBCandidateConvergence(receipts, optionsFor(receipts)).errors).toContain(
      'WIN-B03@normal-16gb did not PASS'
    );
  });
});

describe('Windows Phase B manifest and gate validation', () => {
  it('requires a derived candidate ID and one immutable clean source/build commit', () => {
    expect(validatePhaseBCandidateManifest(MANIFEST)).toEqual({ ok: true, errors: [] });
    const invalid = validatePhaseBCandidateManifest({
      ...MANIFEST,
      candidate_id: 'operator-claimed-ready',
      source: { ...MANIFEST.source, tree_clean: false },
    });
    expect(invalid.errors).toContain(`candidate_id must be ${MANIFEST.candidate_id}`);
    expect(invalid.errors).toContain('source.tree_clean must be true');

    const forgedProvenance = validatePhaseBCandidateManifest({
      ...MANIFEST,
      source: { ...MANIFEST.source, repository: 'attacker/fork' },
      build: {
        ...MANIFEST.build,
        workflow_repository: 'attacker/build-pipeline',
        workflow_commit: 'f'.repeat(40),
      },
    });
    expect(forgedProvenance.errors).toContain('source.repository must be MathiasHeinke/AionUi');
    expect(forgedProvenance.errors).toContain('build.workflow_repository must be MathiasHeinke/AionUi');
    expect(forgedProvenance.errors).toContain('build.workflow_commit must equal source.commit');

    const sensitiveMetadata = validatePhaseBCandidateManifest({
      ...MANIFEST,
      artifact: { ...MANIFEST.artifact, name: 'Command EVE-token=supersecretvalue-win-x64.exe' },
      build: { ...MANIFEST.build, job: 'operator@example.com' },
    });
    expect(sensitiveMetadata.errors).toContain('artifact.name contains sensitive content');
    expect(sensitiveMetadata.errors).toContain('build.job contains sensitive content');

    const nonCanonicalEnvelope = validatePhaseBCandidateManifest({
      ...MANIFEST,
      build: { ...MANIFEST.build, run_id: '000' },
      created_at: '2026-07-15 18:00:00',
    });
    expect(nonCanonicalEnvelope.errors).toContain('build.run_id must be a positive canonical integer string');
    expect(nonCanonicalEnvelope.errors).toContain('created_at must be an ISO-8601 timestamp');
  });

  it('computes PASS from every gate-specific assertion instead of trusting a claimed status', () => {
    const base = receipt('WIN-B10', 'normal-16gb');
    const invalid = validatePhaseBGateReceipt({
      ...base,
      assertions: base.assertions.filter((item) => item.id !== 'tokens-redacted'),
    });

    expect(invalid.errors).toContain('status must be computed as REJECT');
    expect(invalid.errors).toContain('required assertion tokens-redacted must PASS');
  });

  it('re-derives thresholds and rejects bare boolean assertions from the embedded raw evaluation', () => {
    const performance = receipt('WIN-B12', 'lowmem-8gb');
    const thresholdDrift = validatePhaseBGateReceipt({
      ...performance,
      raw_evaluation: {
        ...performance.raw_evaluation,
        observations: {
          ...performance.raw_evaluation.observations,
          idle_process_tree_rss_bytes: PHASE_B_PERFORMANCE_THRESHOLDS.lowmemIdleProcessTreeRssBytes + 1,
        },
      },
    });
    expect(thresholdDrift.errors).toContain('assertions do not match the embedded raw evaluation');
    expect(thresholdDrift.errors).toContain('status does not match the raw evaluation');

    const impossibleMeasurements = validatePhaseBGateReceipt({
      ...performance,
      raw_evaluation: {
        ...performance.raw_evaluation,
        observations: {
          ...performance.raw_evaluation.observations,
          ui_heartbeat_max_gap_ms: -1,
          idle_cpu_median_percent: -1,
          worker_concurrency: 0,
        },
      },
    });
    expect(impossibleMeasurements.errors).toContain('assertions do not match the embedded raw evaluation');
    expect(impossibleMeasurements.errors).toContain('status does not match the raw evaluation');

    const support = receipt('WIN-B10', 'normal-16gb');
    const selfAttested = validatePhaseBGateReceipt({
      ...support,
      raw_evaluation: {
        ...support.raw_evaluation,
        observations: { ...support.raw_evaluation.observations, 'secrets-redacted': true },
      },
    });
    expect(selfAttested.errors).toContain('assertions do not match the embedded raw evaluation');
    expect(selfAttested.errors).toContain('status does not match the raw evaluation');
  });

  it('requires Windows 11 AMD64, a standard user and the correct RAM class for machine PASS', () => {
    const invalid = receipt('WIN-B00', 'lowmem-8gb', {
      execution: {
        target: 'lowmem-8gb',
        os_name: 'Windows Server 2022',
        os_build: '20348',
        native_architecture: 'AMD64',
        process_architecture: 'X64',
        ram_bytes: 16 * 1024 ** 3,
        cpu_count: 2,
        standard_user: false,
      },
    });
    const result = validatePhaseBGateReceipt(invalid);

    expect(result.errors).toContain('machine execution must report Windows 11');
    expect(result.errors).toContain('machine execution.standard_user must be true for PASS');
    expect(result.errors).toContain('lowmem-8gb execution must report between 7 GiB and 10 GiB RAM');
  });

  it('requires actual Cloud-PC, cross-platform or controller provenance for each target', () => {
    const result = validatePhaseBGateReceipt(
      receipt('WIN-B16', 'cross-platform', {
        provenance: provenance('normal-16gb'),
      })
    );
    expect(result.errors).toContain('cross-platform provenance.lane must be cross-platform-ci');
  });

  it('binds every PASS provenance hash to the corresponding verified evidence kind', () => {
    const machine = receipt('WIN-B00', 'lowmem-8gb');
    const machineResult = validatePhaseBGateReceipt({
      ...machine,
      evidence: machine.evidence.filter((item) => item.sha256 !== MACHINE_RECEIPT_SHA256),
    });
    expect(machineResult.errors).toContain('machine provenance receipt SHA-256 must bind a JSON evidence file');

    const parity = receipt('WIN-B16', 'cross-platform');
    const sharedPath = parity.evidence.find((item) => item.sha256 === MAC_RECEIPT_SHA256)?.path;
    const parityResult = validatePhaseBGateReceipt({
      ...parity,
      evidence: parity.evidence.map((item) =>
        item.sha256 === WINDOWS_RECEIPT_SHA256 ? Object.assign({}, item, { path: sharedPath }) : item
      ),
    });
    expect(parityResult.errors).toContain(
      'cross-platform mac and Windows provenance must bind distinct evidence files'
    );

    const controller = receipt('WIN-B18', 'controller');
    const controllerResult = validatePhaseBGateReceipt({
      ...controller,
      evidence: controller.evidence.filter((item) => item.sha256 !== CONTROLLER_REPORT_SHA256),
    });
    expect(controllerResult.errors).toContain('controller provenance report SHA-256 must bind a report evidence file');
  });

  it('rejects sensitive metrics, unsafe evidence paths and missing mandatory evidence kinds', () => {
    const result = validatePhaseBGateReceipt(
      receipt('WIN-B10', 'normal-16gb', {
        metrics: { token_value: 'redacted', nested: { value: 'not allowed' } as unknown as string },
        evidence: [{ path: 'C:\\Users\\operator\\private.log', sha256: EVIDENCE_SHA256, size_bytes: 8, kind: 'json' }],
      })
    );

    expect(result.errors).toContain('metrics.token_value uses a forbidden sensitive-data key');
    expect(result.errors).toContain('metrics.nested must be scalar or null');
    expect(result.errors).toContain('evidence[0].path must be evidence-root-relative');
    expect(result.errors).toContain('PASS evidence is missing required kind markdown');
    expect(result.errors).toContain('PASS evidence is missing required kind artifact');
  });

  it('rejects secrets and PII from every free-text receipt surface', () => {
    const base = receipt('WIN-B10', 'normal-16gb');
    const result = validatePhaseBGateReceipt({
      ...base,
      commands: [{ ...base.commands[0], id: 'api_key=sk-abcdefghijklmnopqrstuvwxyz123456' }],
      assertions: base.assertions.map((item, index) =>
        index === 0 ? Object.assign({}, item, { detail: 'Reviewed by operator@example.com.' }) : item
      ),
      metrics: { note: 'password=supersecretvalue' },
      evidence: base.evidence.map((item, index) =>
        index === 0 ? Object.assign({}, item, { path: 'raw/operator@example.com/proof.json' }) : item
      ),
      raw_evaluation: {
        ...base.raw_evaluation,
        observations: {
          ...base.raw_evaluation.observations,
          review_note: 'password=supersecretvalue',
          token_value: 'redacted',
          oversized_note: 'x'.repeat(257),
        },
      },
      worker: 'operator@example.com',
    });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        'commands[0].id contains sensitive content',
        'assertions[0].detail contains sensitive content',
        'metrics.note contains sensitive content',
        'evidence[0].path contains sensitive content',
        'raw_evaluation.observations.review_note contains sensitive content',
        'raw_evaluation.observations.token_value uses a forbidden sensitive-data key',
        'raw_evaluation.observations.oversized_note exceeds 256 characters',
        'worker contains sensitive content',
      ])
    );
  });

  it('fails closed for malformed input', () => {
    expect(validatePhaseBGateReceipt('PASS')).toEqual({ ok: false, errors: ['receipt must be an object'] });

    const base = receipt('WIN-B00', 'lowmem-8gb');
    const malformedEnvelope = validatePhaseBGateReceipt({
      ...base,
      started_at: '0',
      provenance: { ...base.provenance, run_id: '000' },
    });
    expect(malformedEnvelope.errors).toContain('started_at must be an ISO-8601 timestamp');
    expect(malformedEnvelope.errors).toContain('machine provenance.run_id must be a positive canonical integer string');
  });
});
