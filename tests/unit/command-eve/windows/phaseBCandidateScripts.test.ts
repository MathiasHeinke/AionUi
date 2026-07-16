/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readUtf8RegularFileTruth,
  regularFileTruth,
  resolveExistingRegularFile,
  writeJsonAtomically,
} from '../../../../.github/scripts/windows/phase-b/phase-b-evidence-files';
import { validatePhaseBCandidateDirectory } from '../../../../.github/scripts/windows/phase-b/validate-phase-b-candidate';
import { createPhaseBCandidateManifest } from '../../../../.github/scripts/windows/phase-b/write-phase-b-candidate-manifest';
import { createPhaseBGateReceipt } from '../../../../.github/scripts/windows/phase-b/write-phase-b-gate-receipt';
import {
  PHASE_B_PERFORMANCE_THRESHOLDS,
  PHASE_B_RAW_EVALUATION_SCHEMA_VERSION,
  type PhaseBRawGateEvaluationV1,
} from '@/process/commandEve/windows/phaseBGateEvaluatorCore';
import {
  PHASE_B_GATE_CONTRACTS,
  PHASE_B_REQUIRED_RECEIPTS,
  type PhaseBCandidateManifestV1,
  type PhaseBGateExecution,
  type PhaseBEvidenceKind,
  type PhaseBGateId,
  type PhaseBGateProvenance,
  type PhaseBGateTarget,
} from '@/process/commandEve/windows/phaseBCandidateConvergenceCore';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function minimalWindowsExecutable(): Buffer {
  const executable = Buffer.alloc(512);
  executable.write('MZ', 0, 'ascii');
  executable.writeUInt32LE(0x80, 0x3c);
  executable.write('PE\0\0', 0x80, 'ascii');
  executable.writeUInt16LE(0x8664, 0x84);
  executable.writeUInt16LE(0x020b, 0x98);
  return executable;
}

type CandidateFixture = {
  repositoryRoot: string;
  sourceCommit: string;
  artifactPath: string;
  bundleRoot: string;
  manifestPath: string;
  manifest: PhaseBCandidateManifestV1;
  evidenceRoot: string;
  receiptDirectory: string;
};

function candidateFixture(): CandidateFixture {
  const repositoryRoot = temporaryDirectory('phase-b-source-');
  const bundleRoot = temporaryDirectory('phase-b-bundle-');
  fs.writeFileSync(path.join(repositoryRoot, '.gitignore'), 'out/\n');
  fs.writeFileSync(path.join(repositoryRoot, 'tracked.txt'), 'tracked\n');
  git(repositoryRoot, ['init']);
  git(repositoryRoot, ['config', 'user.email', 'phase-b@example.invalid']);
  git(repositoryRoot, ['config', 'user.name', 'Phase B Test']);
  git(repositoryRoot, ['add', '.gitignore', 'tracked.txt']);
  git(repositoryRoot, ['commit', '-m', 'test fixture']);
  const sourceCommit = git(repositoryRoot, ['rev-parse', 'HEAD']);
  const artifactPath = path.join(repositoryRoot, 'out', 'Command EVE-1.8.14-win-x64.exe');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, minimalWindowsExecutable());
  const manifest = createPhaseBCandidateManifest({
    repositoryRoot,
    sourceRepository: 'MathiasHeinke/AionUi',
    expectedSourceCommit: sourceCommit,
    artifactPath,
    workflowRepository: 'MathiasHeinke/AionUi',
    workflowCommit: sourceCommit,
    runId: '123456789',
    runAttempt: 1,
    job: 'windows-phase-b-candidate',
    createdAt: '2026-07-15T18:00:00.000Z',
  });
  const manifestPath = path.join(bundleRoot, 'candidate-manifest.json');
  writeJsonAtomically(manifestPath, manifest);
  const evidenceRoot = path.join(bundleRoot, 'evidence');
  const receiptDirectory = path.join(bundleRoot, 'receipts');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.mkdirSync(receiptDirectory, { recursive: true });
  return {
    repositoryRoot,
    sourceCommit,
    artifactPath,
    bundleRoot,
    manifestPath,
    manifest,
    evidenceRoot,
    receiptDirectory,
  };
}

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
  if (target === 'cross-platform') return { target, platforms: ['macOS', 'Windows'], same_source_commit: true };
  return { target, controller: 'codex-controller' };
}

function provenance(target: PhaseBGateTarget, sourceCommit: string): PhaseBGateProvenance {
  if (target === 'lowmem-8gb' || target === 'normal-16gb') {
    const memory = target === 'lowmem-8gb' ? 'lowmem' : 'normal';
    return {
      lane: 'windows-cloud-pc',
      workflow_repository: 'MathiasHeinke/command-eve-windows-lab',
      workflow_commit: sourceCommit,
      run_id: '123456789',
      run_attempt: 1,
      job: `phase-b-${target}`,
      runner_binding: 'e'.repeat(32),
      runner_name: `command-eve-phase-b-${memory}-${'e'.repeat(12)}`,
      machine_receipt_sha256: 'f'.repeat(64),
    };
  }
  if (target === 'cross-platform') {
    return {
      lane: 'cross-platform-ci',
      workflow_repository: 'MathiasHeinke/AionUi',
      workflow_commit: sourceCommit,
      run_id: '123456789',
      run_attempt: 1,
      job: 'phase-b-parity',
      mac_receipt_sha256: '1'.repeat(64),
      windows_receipt_sha256: '2'.repeat(64),
    };
  }
  return {
    lane: 'controller-review',
    controller: 'codex-controller',
    source_tree_clean: true,
    report_sha256: '3'.repeat(64),
  };
}

function evidenceExtension(kind: PhaseBEvidenceKind): string {
  if (kind === 'json') return '.json';
  if (kind === 'markdown' || kind === 'report') return '.md';
  if (kind === 'log') return '.log';
  if (kind === 'image' || kind === 'screenshot') return '.png';
  if (kind === 'video') return '.mp4';
  if (kind === 'audio') return '.wav';
  return '.bin';
}

function evidenceContent(kind: PhaseBEvidenceKind, label: string): Buffer | string {
  if (kind === 'json') return `${JSON.stringify({ label, status: 'PASS' })}\n`;
  if (kind === 'markdown' || kind === 'report') return `# ${label}\n\nPASS\n`;
  if (kind === 'log') return `${label} PASS\n`;
  if (kind === 'image' || kind === 'screenshot') {
    return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 24 }, () => 0)]);
  }
  if (kind === 'video') return Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  if (kind === 'audio') return Buffer.from('RIFF....WAVEfmt ', 'ascii');
  return `${label} artifact\n`;
}

function evaluation(
  fixture: CandidateFixture,
  gateId: PhaseBGateId,
  target: PhaseBGateTarget
): PhaseBRawGateEvaluationV1 {
  const contract = PHASE_B_GATE_CONTRACTS[gateId];
  const evidence = contract.required_evidence_kinds.map((kind, index) => {
    const relativePath = `raw/${gateId}/${target}/${index}-${kind}${evidenceExtension(kind)}`;
    const absolutePath = path.join(fixture.evidenceRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, evidenceContent(kind, `${gateId} ${target} ${kind}`));
    return { path: relativePath, kind };
  });
  const gateProvenance = provenance(target, fixture.sourceCommit);
  const addProvenanceEvidence = (name: string, kind: 'json' | 'report'): string => {
    const relativePath = `raw/${gateId}/${target}/provenance-${name}.${kind === 'json' ? 'json' : 'md'}`;
    const absolutePath = path.join(fixture.evidenceRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(
      absolutePath,
      kind === 'json'
        ? `${JSON.stringify({ gate_id: gateId, target, provenance: name })}\n`
        : `# ${gateId} ${target} provenance ${name}\n`
    );
    evidence.push({ path: relativePath, kind });
    return regularFileTruth(absolutePath).sha256;
  };
  if (gateProvenance.lane === 'windows-cloud-pc') {
    gateProvenance.machine_receipt_sha256 = addProvenanceEvidence('machine-receipt', 'json');
  } else if (gateProvenance.lane === 'cross-platform-ci') {
    gateProvenance.mac_receipt_sha256 = addProvenanceEvidence('mac-receipt', 'json');
    gateProvenance.windows_receipt_sha256 = addProvenanceEvidence('windows-receipt', 'json');
  } else {
    gateProvenance.report_sha256 = addProvenanceEvidence('controller-report', 'report');
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
  return {
    schema_version: PHASE_B_RAW_EVALUATION_SCHEMA_VERSION,
    gate_id: gateId,
    evaluation_outcome: 'completed',
    execution: execution(target),
    provenance: gateProvenance,
    commands: [{ id: commandId, exit_code: 0, duration_ms: 100 }],
    observations,
    metrics: { check_count: contract.required_assertion_ids.length },
    evidence,
    started_at: '2026-07-15T18:00:00.000Z',
    completed_at: '2026-07-15T18:01:00.000Z',
    worker: 'windows-phase-b-runner',
    reviewer: 'codex-controller',
    completion_sentinel: 'WIN_PHASE_B_RAW_EVALUATION_COMPLETE',
  };
}

function writeCompleteMatrix(fixture: CandidateFixture): void {
  for (const { gate_id, target } of PHASE_B_REQUIRED_RECEIPTS) {
    const receipt = createPhaseBGateReceipt({
      candidateManifestPath: fixture.manifestPath,
      artifactPath: fixture.artifactPath,
      evidenceRoot: fixture.evidenceRoot,
      rawEvaluation: evaluation(fixture, gate_id, target),
    });
    writeJsonAtomically(path.join(fixture.receiptDirectory, `${gate_id}--${target}.json`), receipt);
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Phase B candidate manifest and gate receipt writers', () => {
  it('binds one clean source commit, artifact, manifest and evidence without accepting a claimed PASS field', () => {
    const fixture = candidateFixture();
    const input = evaluation(fixture, 'WIN-B00', 'lowmem-8gb');
    expect(input).not.toHaveProperty('status');
    expect(input).not.toHaveProperty('assertions');

    const receipt = createPhaseBGateReceipt({
      candidateManifestPath: fixture.manifestPath,
      artifactPath: fixture.artifactPath,
      evidenceRoot: fixture.evidenceRoot,
      rawEvaluation: input,
    });

    expect(receipt.status).toBe('PASS');
    expect(receipt.candidate_id).toBe(fixture.manifest.candidate_id);
    expect(receipt.candidate_manifest_sha256).toBe(regularFileTruth(fixture.manifestPath).sha256);
    expect(receipt.artifact).toEqual(fixture.manifest.artifact);
    expect(receipt.evidence.every((item) => item.size_bytes > 0)).toBe(true);
    expect(receipt.completion_sentinel).toBe('WIN_PHASE_B_GATE_COMPLETE');
  });

  it('rejects a renamed dummy file before issuing a Windows candidate manifest', () => {
    const fixture = candidateFixture();
    fs.writeFileSync(fixture.artifactPath, 'not-a-windows-executable');
    expect(() =>
      createPhaseBCandidateManifest({
        repositoryRoot: fixture.repositoryRoot,
        sourceRepository: 'MathiasHeinke/AionUi',
        expectedSourceCommit: fixture.sourceCommit,
        artifactPath: fixture.artifactPath,
        workflowRepository: 'MathiasHeinke/AionUi',
        workflowCommit: fixture.sourceCommit,
        runId: '123456789',
        runAttempt: 1,
        job: 'windows-phase-b-candidate',
        createdAt: '2026-07-15T18:00:00.000Z',
      })
    ).toThrow('not a recognized PE executable');
  });

  it('refuses candidate issuance from a dirty tracked source tree', () => {
    const repositoryRoot = temporaryDirectory('phase-b-dirty-');
    fs.writeFileSync(path.join(repositoryRoot, '.gitignore'), 'out/\n');
    fs.writeFileSync(path.join(repositoryRoot, 'tracked.txt'), 'clean\n');
    git(repositoryRoot, ['init']);
    git(repositoryRoot, ['config', 'user.email', 'phase-b@example.invalid']);
    git(repositoryRoot, ['config', 'user.name', 'Phase B Test']);
    git(repositoryRoot, ['add', '.gitignore', 'tracked.txt']);
    git(repositoryRoot, ['commit', '-m', 'test fixture']);
    const sourceCommit = git(repositoryRoot, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(repositoryRoot, 'tracked.txt'), 'dirty\n');
    const artifactPath = path.join(repositoryRoot, 'out', 'Command EVE-1.8.14-win-x64.exe');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, minimalWindowsExecutable());

    expect(() =>
      createPhaseBCandidateManifest({
        repositoryRoot,
        sourceRepository: 'MathiasHeinke/AionUi',
        expectedSourceCommit: sourceCommit,
        artifactPath,
        workflowRepository: 'MathiasHeinke/AionUi',
        workflowCommit: sourceCommit,
        runId: '123',
        runAttempt: 1,
        job: 'candidate',
        createdAt: '2026-07-15T18:00:00.000Z',
      })
    ).toThrow('candidate manifest requires a clean source tree');
  });

  it('refuses traversal, symlink evidence and output overwrite', () => {
    const fixture = candidateFixture();
    const outside = path.join(fixture.bundleRoot, 'outside.txt');
    fs.writeFileSync(outside, 'outside');
    const linked = path.join(fixture.evidenceRoot, 'linked.txt');
    fs.symlinkSync(outside, linked);
    const base = evaluation(fixture, 'WIN-B00', 'lowmem-8gb');
    base.evidence = [{ path: 'linked.txt', kind: 'json' }];
    expect(() =>
      createPhaseBGateReceipt({
        candidateManifestPath: fixture.manifestPath,
        artifactPath: fixture.artifactPath,
        evidenceRoot: fixture.evidenceRoot,
        rawEvaluation: base,
      })
    ).toThrow('must not contain symlinks');

    const outputPath = path.join(fixture.bundleRoot, 'receipt.json');
    writeJsonAtomically(outputPath, { status: 'PASS' });
    expect(() => writeJsonAtomically(outputPath, { status: 'PASS' })).toThrow('refusing to overwrite');

    const truth = readUtf8RegularFileTruth(outputPath);
    expect(truth).toMatchObject({ text: '{\n  "status": "PASS"\n}\n', ...regularFileTruth(outputPath) });
    expect(() => readUtf8RegularFileTruth(outputPath, 2)).toThrow('file exceeds 2 bytes');

    const invalidUtf8Path = path.join(fixture.bundleRoot, 'invalid-utf8.json');
    fs.writeFileSync(invalidUtf8Path, Buffer.from([0x7b, 0xff, 0x7d]));
    expect(() => readUtf8RegularFileTruth(invalidUtf8Path)).toThrow('file is not valid UTF-8');
  });

  it('rejects symlinked parent directories and non-canonical relative evidence paths', () => {
    const fixture = candidateFixture();
    const outsideDirectory = path.join(fixture.bundleRoot, 'outside-evidence');
    fs.mkdirSync(outsideDirectory);
    fs.writeFileSync(path.join(outsideDirectory, 'proof.json'), '{}\n');
    const linkedDirectory = path.join(fixture.evidenceRoot, 'linked-parent');
    fs.symlinkSync(outsideDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => resolveExistingRegularFile(fixture.evidenceRoot, 'linked-parent/proof.json')).toThrow(
      'must not contain symlinks'
    );
    expect(() => resolveExistingRegularFile(fixture.evidenceRoot, './proof.json')).toThrow(
      'must be relative to its bundle root'
    );
    expect(() => resolveExistingRegularFile(fixture.evidenceRoot, 'nested//proof.json')).toThrow(
      'must be relative to its bundle root'
    );

    const hardlinkOutside = path.join(fixture.bundleRoot, 'hardlink-source.json');
    const hardlinkInside = path.join(fixture.evidenceRoot, 'hardlink-proof.json');
    fs.writeFileSync(hardlinkOutside, '{}\n');
    fs.linkSync(hardlinkOutside, hardlinkInside);
    expect(() => resolveExistingRegularFile(fixture.evidenceRoot, 'hardlink-proof.json')).toThrow(
      'must have exactly one hard link'
    );
  });

  it('rejects dummy media and bare boolean assertion claims', () => {
    const fixture = candidateFixture();
    const mediaRaw = evaluation(fixture, 'WIN-B05', 'normal-16gb');
    const video = mediaRaw.evidence.find((item) => item.kind === 'video');
    expect(video).toBeDefined();
    fs.writeFileSync(path.join(fixture.evidenceRoot, video!.path), 'not a video');
    expect(() =>
      createPhaseBGateReceipt({
        candidateManifestPath: fixture.manifestPath,
        artifactPath: fixture.artifactPath,
        evidenceRoot: fixture.evidenceRoot,
        rawEvaluation: mediaRaw,
      })
    ).toThrow('recognized container signature');

    const booleanRaw = evaluation(fixture, 'WIN-B10', 'normal-16gb');
    booleanRaw.observations['secrets-redacted'] = true;
    const receipt = createPhaseBGateReceipt({
      candidateManifestPath: fixture.manifestPath,
      artifactPath: fixture.artifactPath,
      evidenceRoot: fixture.evidenceRoot,
      rawEvaluation: booleanRaw,
    });
    expect(receipt.status).toBe('REJECT');
    expect(receipt.assertions.find((assertion) => assertion.id === 'secrets-redacted')?.status).toBe('REJECT');
  });

  it('rejects claimed performance booleans when measured thresholds are absent or exceeded', () => {
    const fixture = candidateFixture();
    const raw = evaluation(fixture, 'WIN-B12', 'lowmem-8gb');
    raw.observations['memory-bounded'] = true;
    raw.observations.idle_process_tree_rss_bytes = PHASE_B_PERFORMANCE_THRESHOLDS.lowmemIdleProcessTreeRssBytes + 1;

    const receipt = createPhaseBGateReceipt({
      candidateManifestPath: fixture.manifestPath,
      artifactPath: fixture.artifactPath,
      evidenceRoot: fixture.evidenceRoot,
      rawEvaluation: raw,
    });

    expect(receipt.status).toBe('REJECT');
    expect(receipt.assertions.find((assertion) => assertion.id === 'memory-bounded')?.status).toBe('REJECT');
    expect(receipt.reject_code).toBe('WIN_B12_GATE_REJECT');
  });

  it('rejects normal-profile latency claims when any measured p95 exceeds its gate budget', () => {
    const fixture = candidateFixture();
    const raw = evaluation(fixture, 'WIN-B13', 'normal-16gb');
    raw.observations['chat-latency'] = true;
    raw.observations.chat_first_response_p95_ms = PHASE_B_PERFORMANCE_THRESHOLDS.normalChatFirstResponseP95Ms + 1;

    const receipt = createPhaseBGateReceipt({
      candidateManifestPath: fixture.manifestPath,
      artifactPath: fixture.artifactPath,
      evidenceRoot: fixture.evidenceRoot,
      rawEvaluation: raw,
    });

    expect(receipt.status).toBe('REJECT');
    expect(receipt.assertions.find((assertion) => assertion.id === 'chat-latency')?.status).toBe('REJECT');
    expect(receipt.reject_code).toBe('WIN_B13_GATE_REJECT');
  });

  it('rejects soak claims without the full duration, sample floor and bounded process-tree growth', () => {
    const fixture = candidateFixture();
    const raw = evaluation(fixture, 'WIN-B14', 'normal-16gb');
    raw.observations['eight-hour-duration'] = true;
    raw.observations['no-leak'] = true;
    raw.observations.soak_duration_ms = PHASE_B_PERFORMANCE_THRESHOLDS.soakDurationMs - 1;
    raw.observations.sample_count = PHASE_B_PERFORMANCE_THRESHOLDS.soakMinimumSamples - 1;
    raw.observations.rss_growth_percent = PHASE_B_PERFORMANCE_THRESHOLDS.soakMaximumRssGrowthPercent + 0.01;

    const receipt = createPhaseBGateReceipt({
      candidateManifestPath: fixture.manifestPath,
      artifactPath: fixture.artifactPath,
      evidenceRoot: fixture.evidenceRoot,
      rawEvaluation: raw,
    });

    expect(receipt.status).toBe('REJECT');
    expect(receipt.assertions.find((assertion) => assertion.id === 'eight-hour-duration')?.status).toBe('REJECT');
    expect(receipt.assertions.find((assertion) => assertion.id === 'no-leak')?.status).toBe('REJECT');
    expect(receipt.reject_code).toBe('WIN_B14_GATE_REJECT');
  });

  it('records a blocked raw outcome without allowing gate assertions or convergence PASS', () => {
    const fixture = candidateFixture();
    const raw = evaluation(fixture, 'WIN-B03', 'normal-16gb');
    raw.evaluation_outcome = 'blocked-auth';
    raw.observations = Object.fromEntries(
      PHASE_B_GATE_CONTRACTS['WIN-B03'].required_assertion_ids.map((id) => [id, true])
    );
    raw.evidence = [];

    const receipt = createPhaseBGateReceipt({
      candidateManifestPath: fixture.manifestPath,
      artifactPath: fixture.artifactPath,
      evidenceRoot: fixture.evidenceRoot,
      rawEvaluation: raw,
    });

    expect(receipt.status).toBe('BLOCKED_AUTH');
    expect(receipt.reject_code).toBe('WIN_B03_BLOCKED_AUTH');
    expect(receipt.assertions.every((assertion) => assertion.status === 'REJECT')).toBe(true);
  });

  it('rejects malformed raw evaluator envelopes before a receipt can be issued', () => {
    const fixture = candidateFixture();
    const raw = evaluation(fixture, 'WIN-B13', 'normal-16gb');
    raw.schema_version = 'invalid' as typeof raw.schema_version;

    expect(() =>
      createPhaseBGateReceipt({
        candidateManifestPath: fixture.manifestPath,
        artifactPath: fixture.artifactPath,
        evidenceRoot: fixture.evidenceRoot,
        rawEvaluation: raw,
      })
    ).toThrow('raw evaluation schema_version');
  });
});

describe('Phase B candidate directory validator', () => {
  it('accepts the exact canonical matrix only after reopening every evidence file', () => {
    const fixture = candidateFixture();
    writeCompleteMatrix(fixture);

    const result = validatePhaseBCandidateDirectory({
      candidateManifestPath: fixture.manifestPath,
      artifactPath: fixture.artifactPath,
      receiptDirectory: fixture.receiptDirectory,
      evidenceRoot: fixture.evidenceRoot,
    });

    expect(result.status).toBe('PASS');
    expect(result.accepted_receipt_count).toBe(26);
    expect(result.completion_sentinel).toBe('WIN_PHASE_B_INTERNAL_PRESENTATION_CONVERGENCE_COMPLETE');
  });

  it('rejects evidence or artifact mutation after receipt creation', () => {
    const fixture = candidateFixture();
    writeCompleteMatrix(fixture);
    fs.appendFileSync(path.join(fixture.evidenceRoot, 'raw', 'WIN-B12', 'lowmem-8gb', '0-json.json'), '\n');
    fs.appendFileSync(fixture.artifactPath, 'tampered');

    const result = validatePhaseBCandidateDirectory({
      candidateManifestPath: fixture.manifestPath,
      artifactPath: fixture.artifactPath,
      receiptDirectory: fixture.receiptDirectory,
      evidenceRoot: fixture.evidenceRoot,
    });

    expect(result.status).toBe('REJECT');
    expect(result.errors).toContain('candidate artifact does not match the immutable candidate manifest');
    expect(result.errors).toContain('WIN-B12@lowmem-8gb evidence SHA-256 mismatch: raw/WIN-B12/lowmem-8gb/0-json.json');
  });

  it('rejects a renamed or non-receipt JSON file instead of silently skipping it', () => {
    const fixture = candidateFixture();
    writeCompleteMatrix(fixture);
    const canonical = path.join(fixture.receiptDirectory, 'WIN-B19--controller.json');
    fs.renameSync(canonical, path.join(fixture.receiptDirectory, 'renamed.json'));
    fs.writeFileSync(path.join(fixture.receiptDirectory, 'untrusted.json'), JSON.stringify({ status: 'PASS' }));

    const result = validatePhaseBCandidateDirectory({
      candidateManifestPath: fixture.manifestPath,
      artifactPath: fixture.artifactPath,
      receiptDirectory: fixture.receiptDirectory,
      evidenceRoot: fixture.evidenceRoot,
    });

    expect(result.status).toBe('REJECT');
    expect(result.errors).toContain('renamed.json: expected file name WIN-B19--controller.json');
    expect(result.errors.some((error) => error.startsWith('untrusted.json:'))).toBe(true);
  });

  it('rejects every unexpected non-JSON or non-file receipt-directory entry', () => {
    const fixture = candidateFixture();
    writeCompleteMatrix(fixture);
    fs.writeFileSync(path.join(fixture.receiptDirectory, 'operator-notes.txt'), 'not a receipt');
    fs.mkdirSync(path.join(fixture.receiptDirectory, 'nested'));

    const result = validatePhaseBCandidateDirectory({
      candidateManifestPath: fixture.manifestPath,
      artifactPath: fixture.artifactPath,
      receiptDirectory: fixture.receiptDirectory,
      evidenceRoot: fixture.evidenceRoot,
    });

    expect(result.status).toBe('REJECT');
    expect(result.errors).toContain('operator-notes.txt: unexpected receipt-directory entry');
    expect(result.errors).toContain('nested: unexpected receipt-directory entry');
  });
});
