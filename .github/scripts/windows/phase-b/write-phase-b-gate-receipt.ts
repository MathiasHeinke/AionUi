/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

import {
  PHASE_B_GATE_SCHEMA_VERSION,
  phaseBGateEvaluation,
  validatePhaseBCandidateManifest,
  validatePhaseBGateReceipt,
  type PhaseBCandidateManifestV1,
  type PhaseBGateReceiptV1,
} from '../../../../packages/desktop/src/process/commandEve/windows/phaseBCandidateConvergenceCore';
import {
  evaluatePhaseBRawGate,
  type PhaseBRawGateEvaluationV1,
} from '../../../../packages/desktop/src/process/commandEve/windows/phaseBGateEvaluatorCore';
import {
  readUtf8RegularFileTruth,
  regularEvidenceFileTruth,
  resolveExistingRegularFile,
  windowsExecutableTruth,
  writeJsonAtomically,
} from './phase-b-evidence-files';

export { writeJsonAtomically } from './phase-b-evidence-files';

export type CreatePhaseBGateReceiptOptions = {
  candidateManifestPath: string;
  artifactPath: string;
  evidenceRoot: string;
  rawEvaluation: PhaseBRawGateEvaluationV1;
};

function readCandidateManifest(filePath: string): {
  manifest: PhaseBCandidateManifestV1;
  sha256: string;
  size_bytes: number;
} {
  const truth = readUtf8RegularFileTruth(path.resolve(filePath));
  const parsed = JSON.parse(truth.text) as unknown;
  const validation = validatePhaseBCandidateManifest(parsed);
  if (!validation.ok) throw new Error(`invalid candidate manifest: ${validation.errors.join('; ')}`);
  return { manifest: parsed as PhaseBCandidateManifestV1, sha256: truth.sha256, size_bytes: truth.size_bytes };
}

export function createPhaseBGateReceipt(options: CreatePhaseBGateReceiptOptions): PhaseBGateReceiptV1 {
  const manifestPath = path.resolve(options.candidateManifestPath);
  const manifestTruth = readCandidateManifest(manifestPath);
  const manifest = manifestTruth.manifest;
  const artifactTruth = windowsExecutableTruth(options.artifactPath);
  if (
    path.basename(options.artifactPath) !== manifest.artifact.name ||
    artifactTruth.sha256 !== manifest.artifact.sha256 ||
    artifactTruth.size_bytes !== manifest.artifact.size_bytes
  ) {
    throw new Error('candidate artifact does not match the immutable candidate manifest');
  }
  const evaluation = evaluatePhaseBRawGate(options.rawEvaluation);
  const evidenceIdentities = new Map<string, string>();
  const evidence = evaluation.evidence.map((item) => {
    const normalizedPath = item.path.replaceAll('\\', '/');
    const absolute = resolveExistingRegularFile(options.evidenceRoot, normalizedPath);
    const truth = regularEvidenceFileTruth(absolute, item.kind);
    const priorPath = evidenceIdentities.get(truth.file_identity);
    if (priorPath && priorPath !== normalizedPath) {
      throw new Error(`evidence files must not alias the same filesystem identity: ${priorPath}, ${normalizedPath}`);
    }
    evidenceIdentities.set(truth.file_identity, normalizedPath);
    return { path: normalizedPath, sha256: truth.sha256, size_bytes: truth.size_bytes, kind: item.kind };
  });
  const computed = phaseBGateEvaluation(evaluation.gate_id, evaluation.evaluation_outcome, evaluation.assertions);
  const receipt: PhaseBGateReceiptV1 = {
    schema_version: PHASE_B_GATE_SCHEMA_VERSION,
    candidate_id: manifest.candidate_id,
    candidate_manifest_sha256: manifestTruth.sha256,
    gate_id: evaluation.gate_id,
    ...computed,
    evaluation_outcome: evaluation.evaluation_outcome,
    source: manifest.source,
    artifact: manifest.artifact,
    execution: evaluation.execution,
    provenance: evaluation.provenance,
    commands: evaluation.commands,
    assertions: evaluation.assertions,
    metrics: evaluation.metrics,
    evidence,
    raw_evaluation: {
      schema_version: options.rawEvaluation.schema_version,
      observations: options.rawEvaluation.observations,
      completion_sentinel: options.rawEvaluation.completion_sentinel,
    },
    started_at: evaluation.started_at,
    completed_at: evaluation.completed_at,
    worker: evaluation.worker,
    reviewer: evaluation.reviewer,
    completion_sentinel: 'WIN_PHASE_B_GATE_COMPLETE',
  };
  const validation = validatePhaseBGateReceipt(receipt);
  if (!validation.ok) {
    throw new Error(`invalid ${receipt.gate_id} receipt: ${validation.errors.join('; ')}`);
  }
  return receipt;
}

function parseArguments(argv: string[]): {
  candidateManifestPath: string;
  artifactPath: string;
  evidenceRoot: string;
  evaluationPath: string;
  outputPath: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value) throw new Error('arguments must use --name value pairs');
    values.set(name, value);
  }
  const candidateManifestPath = values.get('--candidate-manifest');
  const artifactPath = values.get('--artifact');
  const evidenceRoot = values.get('--evidence-root');
  const evaluationPath = values.get('--raw-evaluation');
  const outputPath = values.get('--out');
  if (!candidateManifestPath || !artifactPath || !evidenceRoot || !evaluationPath || !outputPath) {
    throw new Error(
      'missing Phase B gate receipt argument; expected --candidate-manifest, --artifact, --evidence-root, --raw-evaluation and --out'
    );
  }
  return { candidateManifestPath, artifactPath, evidenceRoot, evaluationPath, outputPath };
}

if (import.meta.main) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const rawEvaluation = JSON.parse(
      readUtf8RegularFileTruth(path.resolve(args.evaluationPath)).text
    ) as PhaseBRawGateEvaluationV1;
    const receipt = createPhaseBGateReceipt({
      candidateManifestPath: args.candidateManifestPath,
      artifactPath: args.artifactPath,
      evidenceRoot: args.evidenceRoot,
      rawEvaluation,
    });
    writeJsonAtomically(args.outputPath, receipt);
    process.stdout.write(
      `${receipt.gate_id}@${receipt.execution.target} ${receipt.status} WIN_PHASE_B_GATE_COMPLETE\n`
    );
    if (receipt.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `WIN_PHASE_B_GATE_RECEIPT_ERROR ${error instanceof Error ? error.message : 'unknown error'}\n`
    );
    process.exitCode = 1;
  }
}
