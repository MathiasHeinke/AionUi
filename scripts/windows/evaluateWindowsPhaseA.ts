#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  evaluatePhaseACloudTurn,
  evaluatePhaseAHermesTurnHolder,
  evaluatePhaseAInstallLifecycle,
  type PhaseALifecycleEvidence,
} from '../../packages/desktop/src/process/commandEve/windows/phaseALifecycleCore';
import {
  evaluatePhaseAConvergence,
  PHASE_A_REQUIRED_GATE_IDS,
} from '../../packages/desktop/src/process/commandEve/windows/phaseAConvergenceCore';
import type {
  WindowsGateCommandReceipt,
  WindowsGateReceiptV1,
} from '../../packages/desktop/src/process/commandEve/windows/types';
import { createWindowsGateReceipt, writeAtomicJson, type WindowsGateReceiptDraft } from './writeWindowsGateReceipt';

type PhaseARawEvidence = PhaseALifecycleEvidence & {
  artifact_path: string;
  environment: WindowsGateReceiptV1['environment'];
  commands: WindowsGateCommandReceipt[];
  started_at: string;
  completed_at: string;
  evidence_paths: string[];
};

function parseArgs(argv: string[]): { rawPath: string; gateDirectory: string } {
  const result = { rawPath: '', gateDirectory: 'reports/windows/phase-a/gates' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--raw') result.rawPath = argv[++index] || '';
    else if (argument === '--gate-dir') result.gateDirectory = argv[++index] || '';
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!result.rawPath || !result.gateDirectory) throw new Error('--raw and --gate-dir are required');
  return result;
}

function gateDraft(
  raw: PhaseARawEvidence,
  gateId: 'WIN-G06' | 'WIN-G06T' | 'WIN-G07',
  evaluation: ReturnType<typeof evaluatePhaseAInstallLifecycle>
): WindowsGateReceiptDraft {
  return {
    gate_id: gateId,
    status: evaluation.status,
    reject_code: evaluation.reject_code,
    artifact: { path: raw.artifact_path, signed: false, signature_subject: null },
    environment: raw.environment,
    commands: raw.commands,
    assertions: evaluation.assertions,
    metrics: evaluation.metrics,
    evidence_paths: raw.evidence_paths,
    started_at: raw.started_at,
    completed_at: raw.completed_at,
    worker: 'windows-2022-phase-a-runner',
    reviewer: 'codex-controller',
  };
}

function readReceipt(gateDirectory: string, gateId: string): WindowsGateReceiptV1 {
  const filePath = path.join(gateDirectory, `${gateId}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`missing gate receipt: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as WindowsGateReceiptV1;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(fs.readFileSync(path.resolve(args.rawPath), 'utf8')) as PhaseARawEvidence;
  const gateDirectory = path.resolve(args.gateDirectory);
  fs.mkdirSync(gateDirectory, { recursive: true });

  const evaluations = [
    ['WIN-G06', evaluatePhaseAInstallLifecycle(raw)],
    ['WIN-G06T', evaluatePhaseAHermesTurnHolder(raw)],
    ['WIN-G07', evaluatePhaseACloudTurn(raw)],
  ] as const;
  for (const [gateId, evaluation] of evaluations) {
    writeAtomicJson(
      path.join(gateDirectory, `${gateId}.json`),
      createWindowsGateReceipt(gateDraft(raw, gateId, evaluation))
    );
  }

  const mandatoryReceipts = PHASE_A_REQUIRED_GATE_IDS.map((gateId) => readReceipt(gateDirectory, gateId));
  const convergence = evaluatePhaseAConvergence(mandatoryReceipts);
  const convergenceReceipt = createWindowsGateReceipt({
    gate_id: 'WIN-G08',
    status: convergence.ok ? 'PASS' : 'REJECT',
    reject_code: convergence.reject_code,
    artifact: { path: raw.artifact_path, signed: false, signature_subject: null },
    environment: raw.environment,
    commands: raw.commands,
    assertions: [
      {
        id: 'phase-a-convergence',
        status: convergence.ok ? 'PASS' : 'REJECT',
        detail: convergence.ok
          ? 'Every Phase A gate passed on one clean source commit and one candidate artifact.'
          : `Phase A convergence rejected with ${convergence.errors.length} validation error(s) and ${convergence.missing_gate_ids.length} missing gate(s).`,
      },
    ],
    metrics: {
      source_commit: convergence.source_commit,
      artifact_sha256: convergence.artifact_sha256,
      missing_gate_count: convergence.missing_gate_ids.length,
      error_count: convergence.errors.length,
    },
    evidence_paths: [
      ...raw.evidence_paths,
      ...PHASE_A_REQUIRED_GATE_IDS.map((gateId) => `reports/windows/phase-a/gates/${gateId}.json`),
    ],
    started_at: raw.started_at,
    completed_at: new Date().toISOString(),
    worker: 'windows-2022-phase-a-runner',
    reviewer: 'codex-controller',
  });
  writeAtomicJson(path.join(gateDirectory, 'WIN-G08.json'), convergenceReceipt);
  writeAtomicJson(path.join(gateDirectory, 'phase-a-convergence.json'), convergence);

  if (!convergence.ok) {
    console.error(
      `[windows-phase-a] REJECT missing=${convergence.missing_gate_ids.join(',') || 'none'} errors=${convergence.errors.join(' | ') || 'none'}`
    );
    process.exitCode = 1;
    return;
  }
  console.log('WINDOWS_X64_PROOF');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[evaluate-windows-phase-a] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
