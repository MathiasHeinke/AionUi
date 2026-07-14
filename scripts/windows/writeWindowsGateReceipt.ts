#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  WINDOWS_GATE_SCHEMA_VERSION,
  type WindowsDeliveryArtifactReceipt,
  type WindowsGateReceiptV1,
} from '../../packages/desktop/src/process/commandEve/windows/types';
import { validateWindowsGateReceipt } from '../../packages/desktop/src/process/commandEve/windows/windowsGateReceiptCore';

type ArtifactDraft = {
  path: string;
  signed: boolean;
  signature_subject: string | null;
};

export type WindowsGateReceiptDraft = Omit<
  WindowsGateReceiptV1,
  'schema_version' | 'source' | 'artifact' | 'completion_sentinel'
> & {
  repository?: string;
  artifact?: ArtifactDraft | null;
};

function sha256File(filePath: string): string {
  const hash = createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function trackedTreeIsClean(): boolean {
  try {
    execFileSync('git', ['diff', '--quiet']);
    execFileSync('git', ['diff', '--cached', '--quiet']);
    return true;
  } catch {
    return false;
  }
}

function artifactReceipt(draft: ArtifactDraft | null | undefined): WindowsDeliveryArtifactReceipt | null {
  if (!draft) return null;
  const absolutePath = path.resolve(draft.path);
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    throw new Error(`artifact does not exist: ${draft.path}`);
  }
  return {
    name: path.basename(absolutePath),
    sha256: sha256File(absolutePath),
    signed: draft.signed,
    signature_subject: draft.signature_subject,
  };
}

export function createWindowsGateReceipt(draft: WindowsGateReceiptDraft): WindowsGateReceiptV1 {
  const receipt: WindowsGateReceiptV1 = {
    schema_version: WINDOWS_GATE_SCHEMA_VERSION,
    gate_id: draft.gate_id,
    status: draft.status,
    reject_code: draft.reject_code,
    source: {
      repository: draft.repository || 'command-eve-aionui',
      commit: git(['rev-parse', 'HEAD']),
      tree_clean: trackedTreeIsClean(),
    },
    artifact: artifactReceipt(draft.artifact),
    environment: draft.environment,
    commands: draft.commands,
    assertions: draft.assertions,
    metrics: draft.metrics,
    evidence_paths: draft.evidence_paths,
    started_at: draft.started_at,
    completed_at: draft.completed_at,
    worker: draft.worker,
    reviewer: draft.reviewer,
    completion_sentinel: 'WIN_GATE_COMPLETE',
  };
  const validation = validateWindowsGateReceipt(receipt);
  if (!validation.ok) {
    throw new Error(`invalid ${receipt.gate_id} receipt: ${validation.errors.join('; ')}`);
  }
  return receipt;
}

export function writeAtomicJson(filePath: string, value: unknown): void {
  const absolutePath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporaryPath, absolutePath);
}

function parseArgs(argv: string[]): { draftPath: string; outputPath: string } {
  const result = { draftPath: '', outputPath: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--draft') result.draftPath = argv[++index] || '';
    else if (argument === '--out') result.outputPath = argv[++index] || '';
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!result.draftPath || !result.outputPath) throw new Error('--draft and --out are required');
  return result;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const draft = JSON.parse(fs.readFileSync(path.resolve(args.draftPath), 'utf8')) as WindowsGateReceiptDraft;
  const receipt = createWindowsGateReceipt(draft);
  writeAtomicJson(args.outputPath, receipt);
  console.log(`${receipt.gate_id} ${receipt.status} WIN_GATE_COMPLETE`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[write-windows-gate-receipt] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
