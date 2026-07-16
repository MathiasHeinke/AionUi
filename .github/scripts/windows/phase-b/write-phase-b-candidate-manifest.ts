/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  PHASE_B_CANDIDATE_SCHEMA_VERSION,
  phaseBCandidateId,
  validatePhaseBCandidateManifest,
  type PhaseBCandidateManifestV1,
} from '../../../../packages/desktop/src/process/commandEve/windows/phaseBCandidateConvergenceCore';
import { windowsExecutableTruth, writeJsonAtomically } from './phase-b-evidence-files';

export type CreatePhaseBCandidateManifestOptions = {
  repositoryRoot: string;
  sourceRepository: string;
  expectedSourceCommit: string;
  artifactPath: string;
  workflowRepository: string;
  workflowCommit: string;
  runId: string;
  runAttempt: number;
  job: string;
  createdAt: string;
};

function git(repositoryRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

export function createPhaseBCandidateManifest(
  options: CreatePhaseBCandidateManifestOptions
): PhaseBCandidateManifestV1 {
  const repositoryRoot = path.resolve(options.repositoryRoot);
  const sourceCommit = git(repositoryRoot, ['rev-parse', 'HEAD']);
  if (sourceCommit !== options.expectedSourceCommit) {
    throw new Error('checked-out source commit does not match the expected candidate commit');
  }
  if (git(repositoryRoot, ['status', '--porcelain', '--untracked-files=all']) !== '') {
    throw new Error('candidate manifest requires a clean source tree');
  }
  const artifactPath = path.resolve(options.artifactPath);
  const artifact = windowsExecutableTruth(artifactPath);
  if (
    git(repositoryRoot, ['rev-parse', 'HEAD']) !== sourceCommit ||
    git(repositoryRoot, ['status', '--porcelain', '--untracked-files=all']) !== ''
  ) {
    throw new Error('source tree changed while the candidate artifact was being bound');
  }
  const manifest: PhaseBCandidateManifestV1 = {
    schema_version: PHASE_B_CANDIDATE_SCHEMA_VERSION,
    candidate_id: phaseBCandidateId(sourceCommit, artifact.sha256),
    source: { repository: options.sourceRepository, commit: sourceCommit, tree_clean: true },
    artifact: { name: path.basename(artifactPath), ...artifact },
    build: {
      workflow_repository: options.workflowRepository,
      workflow_commit: options.workflowCommit,
      run_id: options.runId,
      run_attempt: options.runAttempt,
      job: options.job,
      runner_os: 'Windows',
      runner_arch: 'X64',
    },
    created_at: options.createdAt,
    completion_sentinel: 'WIN_PHASE_B_CANDIDATE_MANIFEST_COMPLETE',
  };
  const validation = validatePhaseBCandidateManifest(manifest);
  if (!validation.ok) throw new Error(`invalid candidate manifest: ${validation.errors.join('; ')}`);
  return manifest;
}

function parseArguments(argv: string[]): CreatePhaseBCandidateManifestOptions & { outputPath: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value) throw new Error('arguments must use --name value pairs');
    values.set(name, value);
  }
  const repositoryRoot = values.get('--repository-root');
  const sourceRepository = values.get('--source-repository');
  const expectedSourceCommit = values.get('--expected-source-commit');
  const artifactPath = values.get('--artifact');
  const workflowRepository = values.get('--workflow-repository');
  const workflowCommit = values.get('--workflow-commit');
  const runId = values.get('--run-id');
  const runAttemptValue = values.get('--run-attempt');
  const job = values.get('--job');
  const createdAt = values.get('--created-at');
  const outputPath = values.get('--out');
  const runAttempt = Number(runAttemptValue);
  if (
    !repositoryRoot ||
    !sourceRepository ||
    !expectedSourceCommit ||
    !/^[0-9a-f]{40}$/u.test(expectedSourceCommit) ||
    !artifactPath ||
    !workflowRepository ||
    !workflowCommit ||
    !/^[0-9a-f]{40}$/u.test(workflowCommit) ||
    !runId ||
    !/^\d+$/u.test(runId) ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    !job ||
    !createdAt ||
    !outputPath
  ) {
    throw new Error('missing or invalid Phase B candidate manifest argument');
  }
  return {
    repositoryRoot,
    sourceRepository,
    expectedSourceCommit,
    artifactPath,
    workflowRepository,
    workflowCommit,
    runId,
    runAttempt,
    job,
    createdAt,
    outputPath,
  };
}

if (import.meta.main) {
  try {
    const args = parseArguments(process.argv.slice(2));
    const manifest = createPhaseBCandidateManifest(args);
    writeJsonAtomically(args.outputPath, manifest);
    process.stdout.write(`${manifest.candidate_id} WIN_PHASE_B_CANDIDATE_MANIFEST_COMPLETE\n`);
  } catch (error) {
    process.stderr.write(
      `WIN_PHASE_B_CANDIDATE_MANIFEST_ERROR ${error instanceof Error ? error.message : 'unknown error'}\n`
    );
    process.exitCode = 1;
  }
}
