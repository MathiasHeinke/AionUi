/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  evaluatePhaseBMachineReadiness,
  type PhaseBMemoryClass,
} from '../../../../packages/desktop/src/process/commandEve/windows/phaseBMachineReceiptCore';
import { evaluatePhaseBRunnerPolicy } from '../../../../packages/desktop/src/process/commandEve/windows/phaseBRunnerPolicyCore';

type CliOptions = {
  machineFactsPath: string;
  runnerPolicyPath: string;
  memoryClass: PhaseBMemoryClass;
  expectedControlRepository: string;
  expectedSourceRepository: string;
  expectedSourceRef: string;
  expectedSourceCommit: string;
  expectedWorkflowCommit: string;
  expectedRunnerBinding: string;
  expectedRunnerName: string;
  outputDirectory: string;
  nowMs?: number;
};

function parseArguments(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || !value) throw new Error('Arguments must use --name value pairs.');
    values.set(name, value);
  }
  const machineFactsPath = values.get('--machine-facts');
  const runnerPolicyPath = values.get('--runner-policy');
  const memoryClass = values.get('--memory-class');
  const expectedControlRepository = values.get('--expected-control-repository');
  const expectedSourceRepository = values.get('--expected-source-repository');
  const expectedSourceRef = values.get('--expected-source-ref');
  const expectedSourceCommit = values.get('--expected-source-commit');
  const expectedWorkflowCommit = values.get('--expected-workflow-commit');
  const expectedRunnerBinding = values.get('--expected-runner-binding');
  const expectedRunnerName = values.get('--expected-runner-name');
  const outputDirectory = values.get('--output-directory');
  if (
    !machineFactsPath ||
    !runnerPolicyPath ||
    (memoryClass !== 'lowmem-8gb' && memoryClass !== 'normal-16gb') ||
    !expectedControlRepository ||
    !expectedSourceRepository ||
    !expectedSourceRef ||
    !expectedSourceCommit ||
    !expectedWorkflowCommit ||
    !expectedRunnerBinding ||
    !expectedRunnerName ||
    !outputDirectory
  ) {
    throw new Error('Missing or invalid Phase B evidence validation argument.');
  }
  return {
    machineFactsPath,
    runnerPolicyPath,
    memoryClass,
    expectedControlRepository,
    expectedSourceRepository,
    expectedSourceRef,
    expectedSourceCommit,
    expectedWorkflowCommit,
    expectedRunnerBinding,
    expectedRunnerName,
    outputDirectory,
  };
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')) as unknown;
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, absolute);
}

export function validatePhaseBEvidence(options: CliOptions): { ok: boolean; outputPaths: string[] } {
  const machine = evaluatePhaseBMachineReadiness(
    readJson(options.machineFactsPath),
    options.memoryClass,
    options.nowMs
  );
  const runner = evaluatePhaseBRunnerPolicy(readJson(options.runnerPolicyPath), {
    expected_control_repository: options.expectedControlRepository,
    expected_source_repository: options.expectedSourceRepository,
    expected_source_ref: options.expectedSourceRef,
    expected_source_commit: options.expectedSourceCommit,
    expected_workflow_commit: options.expectedWorkflowCommit,
    expected_runner_binding: options.expectedRunnerBinding,
    expected_runner_name: options.expectedRunnerName,
    memory_class: options.memoryClass,
  });
  const machineOutput = path.join(options.outputDirectory, 'machine-readiness-receipt.json');
  const runnerOutput = path.join(options.outputDirectory, 'runner-policy-receipt.json');
  const summaryOutput = path.join(options.outputDirectory, 'bootstrap-summary.json');
  writeJsonAtomically(machineOutput, machine);
  writeJsonAtomically(runnerOutput, runner);
  const ok = machine.status === 'PASS' && runner.status === 'PASS';
  const outcomeSentinel = ok ? 'WIN_PHASE_B_BOOTSTRAP_VALIDATION_PASS' : 'WIN_PHASE_B_BOOTSTRAP_VALIDATION_REJECT';
  writeJsonAtomically(summaryOutput, {
    schema_version: 'command-eve-windows-phase-b-bootstrap-summary/v2',
    memory_class: options.memoryClass,
    expected_control_repository: options.expectedControlRepository,
    expected_source_repository: options.expectedSourceRepository,
    source_ref: runner.source_ref,
    source_commit: runner.source_commit,
    workflow_commit: runner.workflow_commit,
    runner_binding: runner.runner_binding,
    runner_name: runner.runner_name,
    run_id: runner.run_id,
    run_attempt: runner.run_attempt,
    run_ref: runner.run_ref,
    workflow_ref: runner.workflow_ref,
    machine_status: machine.status,
    runner_status: runner.status,
    status: ok ? 'PASS' : 'REJECT',
    completion_sentinel: outcomeSentinel,
  });
  return {
    ok,
    outputPaths: [machineOutput, runnerOutput, summaryOutput],
  };
}

if (import.meta.main) {
  try {
    const outcome = validatePhaseBEvidence(parseArguments(process.argv.slice(2)));
    const sentinel = outcome.ok ? 'WIN_PHASE_B_BOOTSTRAP_VALIDATION_PASS' : 'WIN_PHASE_B_BOOTSTRAP_VALIDATION_REJECT';
    process.stdout.write(`${sentinel} ${outcome.outputPaths.join(',')}\n`);
    if (!outcome.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `WIN_PHASE_B_BOOTSTRAP_VALIDATION_ERROR ${error instanceof Error ? error.message : 'unknown'}\n`
    );
    process.exitCode = 1;
  }
}
