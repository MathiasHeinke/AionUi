/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  evaluatePhaseBCandidateConvergence,
  PHASE_B_GATE_SCHEMA_VERSION,
  validatePhaseBCandidateManifest,
  type PhaseBCandidateConvergence,
  type PhaseBCandidateManifestV1,
  type PhaseBGateReceiptV1,
} from '../../../../packages/desktop/src/process/commandEve/windows/phaseBCandidateConvergenceCore';
import {
  readUtf8RegularFileTruth,
  regularEvidenceFileTruth,
  resolveExistingRegularFile,
  windowsExecutableTruth,
  writeJsonAtomically,
} from './phase-b-evidence-files';

export type ValidatePhaseBCandidateDirectoryOptions = {
  candidateManifestPath: string;
  artifactPath: string;
  receiptDirectory: string;
  evidenceRoot: string;
};

function expectedFileName(receipt: PhaseBGateReceiptV1): string {
  return `${receipt.gate_id}--${receipt.execution.target}.json`;
}

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

export function validatePhaseBCandidateDirectory(
  options: ValidatePhaseBCandidateDirectoryOptions
): PhaseBCandidateConvergence {
  const manifestPath = path.resolve(options.candidateManifestPath);
  const manifestTruth = readCandidateManifest(manifestPath);
  const manifest = manifestTruth.manifest;
  const artifactTruth = windowsExecutableTruth(options.artifactPath);
  const fileErrors: string[] = [];
  if (
    path.basename(options.artifactPath) !== manifest.artifact.name ||
    artifactTruth.sha256 !== manifest.artifact.sha256 ||
    artifactTruth.size_bytes !== manifest.artifact.size_bytes
  ) {
    fileErrors.push('candidate artifact does not match the immutable candidate manifest');
  }

  const directory = path.resolve(options.receiptDirectory);
  if (!fs.existsSync(directory)) {
    throw new Error('Phase B receipt directory does not exist');
  }
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error('Phase B receipt directory must be a non-symlink directory');
  }
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length === 0) throw new Error('Phase B receipt directory is empty');
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      fileErrors.push(`${entry.name}: unexpected receipt-directory entry`);
    }
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name);

  const receipts: PhaseBGateReceiptV1[] = [];
  for (const fileName of files) {
    try {
      const filePath = resolveExistingRegularFile(directory, fileName);
      const parsed = JSON.parse(readUtf8RegularFileTruth(filePath).text) as PhaseBGateReceiptV1;
      if (parsed.schema_version !== PHASE_B_GATE_SCHEMA_VERSION) {
        fileErrors.push(`${fileName}: unexpected schema_version`);
      }
      const canonicalName = expectedFileName(parsed);
      if (fileName !== canonicalName) fileErrors.push(`${fileName}: expected file name ${canonicalName}`);
      receipts.push(parsed);
    } catch (error) {
      fileErrors.push(`${fileName}: ${error instanceof Error ? error.message : 'invalid JSON'}`);
    }
  }

  const evidenceFiles: Record<string, { sha256: string; size_bytes: number }> = {};
  const evidenceIdentities = new Map<string, string>();
  for (const receipt of receipts) {
    if (!Array.isArray(receipt.evidence)) continue;
    for (const item of receipt.evidence) {
      if (!item || typeof item.path !== 'string' || evidenceFiles[item.path]) continue;
      try {
        const absolute = resolveExistingRegularFile(options.evidenceRoot, item.path);
        const truth = regularEvidenceFileTruth(absolute, item.kind);
        const priorPath = evidenceIdentities.get(truth.file_identity);
        if (priorPath && priorPath !== item.path) {
          throw new Error(`evidence files alias the same filesystem identity: ${priorPath}, ${item.path}`);
        }
        evidenceIdentities.set(truth.file_identity, item.path);
        evidenceFiles[item.path] = { sha256: truth.sha256, size_bytes: truth.size_bytes };
      } catch (error) {
        fileErrors.push(
          `${expectedFileName(receipt)}: ${error instanceof Error ? error.message : 'invalid evidence path'}`
        );
      }
    }
  }

  const convergence = evaluatePhaseBCandidateConvergence(receipts, {
    candidate_manifest: manifest,
    candidate_manifest_sha256: manifestTruth.sha256,
    evidence_files: evidenceFiles,
  });
  if (fileErrors.length === 0) return convergence;
  return {
    ...convergence,
    status: 'REJECT',
    reject_code: 'WIN_PHASE_B_INTERNAL_PRESENTATION_REJECT',
    errors: [...fileErrors, ...convergence.errors],
  };
}

function parseArguments(argv: string[]): ValidatePhaseBCandidateDirectoryOptions & { outputPath: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value) throw new Error('arguments must use --name value pairs');
    values.set(name, value);
  }
  const candidateManifestPath = values.get('--candidate-manifest');
  const artifactPath = values.get('--artifact');
  const receiptDirectory = values.get('--receipt-directory');
  const evidenceRoot = values.get('--evidence-root');
  const outputPath = values.get('--out');
  if (!candidateManifestPath || !artifactPath || !receiptDirectory || !evidenceRoot || !outputPath) {
    throw new Error('missing Phase B candidate validation argument');
  }
  return { candidateManifestPath, artifactPath, receiptDirectory, evidenceRoot, outputPath };
}

if (import.meta.main) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const convergence = validatePhaseBCandidateDirectory(args);
    writeJsonAtomically(args.outputPath, convergence);
    if (convergence.status === 'PASS') {
      process.stdout.write('WINDOWS_PHASE_B_INTERNAL_PRESENTATION_READY\n');
    } else {
      process.stderr.write(
        `WIN_PHASE_B_INTERNAL_PRESENTATION_REJECT missing=${convergence.missing_receipts.length} errors=${convergence.errors.length}\n`
      );
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(
      `WIN_PHASE_B_CANDIDATE_VALIDATION_ERROR ${error instanceof Error ? error.message : 'unknown error'}\n`
    );
    process.exitCode = 1;
  }
}
