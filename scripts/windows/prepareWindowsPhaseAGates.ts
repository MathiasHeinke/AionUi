#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  WindowsGateAssertionReceipt,
  WindowsGateReceiptV1,
} from '../../packages/desktop/src/process/commandEve/windows/types';
import productIdentity from './productIdentity.cjs';
import { createWindowsGateReceipt, writeAtomicJson, type WindowsGateReceiptDraft } from './writeWindowsGateReceipt';

type Arguments = Record<string, string>;

export function hasExactTrimmedLine(source: string, expected: string): boolean {
  return source.split(/\r?\n/u).some((line) => line.trim() === expected);
}

export type PhaseAPreconditionDocuments = {
  decisions: string;
  stateTruth: string;
  contractReview: string;
  reviewStatus: string;
  fableReview: string;
  fablePostbuildReview: string;
  codexPostbuildReview: string;
  glmPostbuildReview: string;
};

export type PhaseAPackageInventory = Record<string, unknown> & {
  status?: string;
  artifacts?: Array<{ path?: string; sha256?: string }>;
  runtime_keys?: string[];
  bundled_python?: { interpreter?: unknown; manifest_receipt?: unknown };
  errors?: unknown[];
};

export type PhaseAPreconditionDocumentChecks = {
  decisionsFrozen: boolean;
  stateTruthComplete: boolean;
  controllerContractPass: boolean;
  independentPrebuildReviewPass: boolean;
  independentPostbuildReviewPass: boolean;
  additionalGlmReviewRecorded: boolean;
};

export function evaluatePhaseAPackageInventory(
  inventory: PhaseAPackageInventory,
  installerName: string,
  installerSha256: string | null
): {
  inventoryPass: boolean;
  singleWindowsRuntime: boolean;
  bundledPythonProvenance: boolean;
  installerHashMatches: boolean;
  noErrors: boolean;
} {
  const inventoryInstaller = inventory.artifacts?.find((item) => path.basename(item.path || '') === installerName);
  return {
    inventoryPass: inventory.status === 'PASS',
    singleWindowsRuntime:
      Array.isArray(inventory.runtime_keys) &&
      inventory.runtime_keys.length === 1 &&
      inventory.runtime_keys[0] === productIdentity.WINDOWS_RUNTIME_KEY,
    bundledPythonProvenance: Boolean(
      inventory.bundled_python?.interpreter && inventory.bundled_python?.manifest_receipt
    ),
    installerHashMatches: Boolean(installerSha256 && inventoryInstaller?.sha256 === installerSha256),
    noErrors: Array.isArray(inventory.errors) && inventory.errors.length === 0,
  };
}

export function evaluatePhaseAPreconditionDocuments(
  documents: PhaseAPreconditionDocuments
): PhaseAPreconditionDocumentChecks {
  return {
    decisionsFrozen: hasExactTrimmedLine(documents.decisions, 'Completion sentinel: `PHASE_A_DECISIONS_FROZEN`'),
    stateTruthComplete:
      hasExactTrimmedLine(documents.stateTruth, 'Verdict: `PASS_FOR_PHASE_A`') &&
      hasExactTrimmedLine(documents.stateTruth, 'Completion sentinel: `WIN_STATE_TRUTH_COMPLETE`'),
    controllerContractPass:
      hasExactTrimmedLine(documents.contractReview, 'Controller verdict: `CONTRACT_PASS`') &&
      hasExactTrimmedLine(documents.contractReview, 'Completion sentinel: `WIN_PHASE_A_CONTRACT_REVIEW_COMPLETE`'),
    independentPrebuildReviewPass:
      hasExactTrimmedLine(documents.reviewStatus, '## Fable 5 Max') &&
      hasExactTrimmedLine(documents.reviewStatus, 'Status: PASS') &&
      hasExactTrimmedLine(documents.reviewStatus, 'Completion sentinel: `PHASE_A_PREBUILD_REVIEW_RECORDED`') &&
      hasExactTrimmedLine(documents.fableReview, 'FABLE_PHASE_A_PREBUILD_COMPLETE'),
    independentPostbuildReviewPass:
      hasExactTrimmedLine(documents.fablePostbuildReview, 'Completion sentinel: `FABLE_PHASE_A_POSTFIX_CONVERGED`') &&
      hasExactTrimmedLine(
        documents.fablePostbuildReview,
        'Delta completion sentinel: `FABLE_PHASE_A_GATE_DELTA_CONVERGED`'
      ) &&
      hasExactTrimmedLine(
        documents.codexPostbuildReview,
        'Completion sentinel: `WIN_PHASE_A_POSTBUILD_REVIEW_CONVERGED`'
      ),
    additionalGlmReviewRecorded:
      hasExactTrimmedLine(documents.glmPostbuildReview, 'Status: `TIMEOUT_INCONCLUSIVE`') &&
      hasExactTrimmedLine(documents.glmPostbuildReview, 'Completion sentinel: `GLM_PHASE_A_POSTFIX_REVIEW_TIMEOUT`'),
  };
}

export function phaseAPreconditionMetrics(checks: PhaseAPreconditionDocumentChecks): {
  state: WindowsGateReceiptV1['metrics'];
  reviews: WindowsGateReceiptV1['metrics'];
} {
  return {
    state: {
      critical_unknown_count: Number(!checks.decisionsFrozen) + Number(!checks.stateTruthComplete),
    },
    reviews: {
      contract_review: checks.controllerContractPass ? 'CONTRACT_PASS' : 'NOT_RECORDED',
      fable_prebuild: checks.independentPrebuildReviewPass ? 'PASS' : 'NOT_RECORDED',
      fable_codex_postbuild: checks.independentPostbuildReviewPass ? 'PASS' : 'NOT_RECORDED',
      glm_postbuild: checks.additionalGlmReviewRecorded ? 'TIMEOUT_INCONCLUSIVE' : 'NOT_RECORDED',
    },
  };
}

export function assertPhaseAGatesPassed(receipts: readonly WindowsGateReceiptV1[]): void {
  const rejected = receipts.filter((receipt) => receipt.status !== 'PASS').map((receipt) => receipt.gate_id);
  if (rejected.length > 0) throw new Error(`Phase A gate preparation rejected: ${rejected.join(', ')}`);
}

function parseArgs(argv: string[]): Arguments {
  const args: Arguments = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`unexpected argument: ${argument}`);
    args[argument.slice(2)] = argv[++index] || '';
  }
  return args;
}

function required(args: Arguments, name: string): string {
  const value = args[name]?.trim();
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function environment(args: Arguments): WindowsGateReceiptV1['environment'] {
  const ramBytes = Number(required(args, 'ram-bytes'));
  const cpuCount = Number(required(args, 'cpu-count'));
  if (!Number.isFinite(ramBytes) || ramBytes < 0) throw new Error('--ram-bytes must be non-negative');
  if (!Number.isInteger(cpuCount) || cpuCount < 1) throw new Error('--cpu-count must be positive');
  return {
    os: required(args, 'os'),
    os_build: required(args, 'os-build'),
    arch: 'x64',
    ram_bytes: ramBytes,
    cpu_count: cpuCount,
    test_mode: required(args, 'test-mode'),
  };
}

function check(id: string, ok: boolean, pass: string, reject: string): WindowsGateAssertionReceipt {
  return { id, status: ok ? 'PASS' : 'REJECT', detail: ok ? pass : reject };
}

function emit(outputDirectory: string, draft: WindowsGateReceiptDraft): WindowsGateReceiptV1 {
  const receipt = createWindowsGateReceipt(draft);
  writeAtomicJson(path.join(outputDirectory, `${receipt.gate_id}.json`), receipt);
  console.log(`${receipt.gate_id} ${receipt.status} WIN_GATE_COMPLETE`);
  return receipt;
}

function baseDraft(
  args: Arguments,
  gateId: WindowsGateReceiptV1['gate_id'],
  assertions: WindowsGateAssertionReceipt[],
  metrics: WindowsGateReceiptV1['metrics'],
  evidencePaths: string[],
  artifact: WindowsGateReceiptDraft['artifact'] = null
): WindowsGateReceiptDraft {
  const pass = assertions.every((item) => item.status === 'PASS');
  return {
    gate_id: gateId,
    status: pass ? 'PASS' : 'REJECT',
    reject_code: pass ? null : required(args, 'reject-code'),
    artifact,
    environment: environment(args),
    commands: [],
    assertions,
    metrics,
    evidence_paths: evidencePaths,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    worker: 'github-actions-windows-phase-a',
    reviewer: 'codex-controller',
  };
}

function prepareBuildGates(args: Arguments): void {
  const outputDirectory = path.resolve(required(args, 'out-dir'));
  const installerPath = path.resolve(required(args, 'installer'));
  const inventoryPath = path.resolve(required(args, 'inventory'));
  const injectedExitCode = Number(required(args, 'injected-exit-code'));
  const signatureStatus = required(args, 'signature-status');
  const installerName = path.basename(installerPath);
  const installerExists = fs.existsSync(installerPath) && fs.statSync(installerPath).isFile();
  const unsigned = signatureStatus === 'NotSigned';

  const g03Assertions = [
    check(
      'injected-build-failure-nonzero',
      Number.isInteger(injectedExitCode) && injectedExitCode !== 0,
      `Injected Windows build failure exited non-zero (${injectedExitCode}).`,
      'Injected Windows build failure returned zero or no usable exit code.'
    ),
  ];
  const receipts: WindowsGateReceiptV1[] = [];
  receipts.push(
    emit(
      outputDirectory,
      baseDraft(
        { ...args, 'reject-code': 'WIN_CI_FALSE_GREEN' },
        'WIN-G03',
        g03Assertions,
        { injected_exit_code: injectedExitCode },
        ['reports/windows/phase-a/gates/WIN-G03.json']
      )
    )
  );

  const g04Assertions = [
    check('installer-present', installerExists, 'NSIS installer exists.', 'NSIS installer is missing.'),
    check(
      'installer-identity',
      /^Command EVE-.+-win-x64\.exe$/.test(installerName),
      'Installer name carries Command EVE and win-x64 identity.',
      'Installer name does not carry the required Command EVE win-x64 identity.'
    ),
    check(
      'unsigned-phase-a-candidate',
      unsigned,
      'Candidate is unsigned as required for Phase A.',
      `Candidate signature status is ${signatureStatus}; Phase A requires NotSigned.`
    ),
  ];
  const g04 = emit(
    outputDirectory,
    baseDraft(
      { ...args, 'reject-code': 'WIN_BUILD_FAILED' },
      'WIN-G04',
      g04Assertions,
      { signature_status: signatureStatus, installer_name: installerName },
      ['reports/windows/phase-a/gates/WIN-G04.json'],
      installerExists && unsigned ? { path: installerPath, signed: false, signature_subject: null } : null
    )
  );
  receipts.push(g04);

  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as PhaseAPackageInventory;
  const packageEvaluation = evaluatePhaseAPackageInventory(inventory, installerName, g04.artifact?.sha256 ?? null);
  const g05Assertions = [
    check(
      'inventory-pass',
      packageEvaluation.inventoryPass,
      'Package inventory passed.',
      'Package inventory rejected.'
    ),
    check(
      'single-windows-runtime',
      packageEvaluation.singleWindowsRuntime,
      `Package contains exactly the ${productIdentity.WINDOWS_RUNTIME_KEY} AionCore runtime.`,
      `Package does not contain exactly one ${productIdentity.WINDOWS_RUNTIME_KEY} AionCore runtime.`
    ),
    check(
      'bundled-python-provenance',
      packageEvaluation.bundledPythonProvenance,
      'Bundled Windows Python and its provenance manifest are present.',
      'Bundled Windows Python or its provenance manifest is missing.'
    ),
    check(
      'inventory-installer-hash',
      packageEvaluation.installerHashMatches,
      'Package inventory and build gate reference the same installer hash.',
      'Package inventory installer hash does not match the build gate.'
    ),
    check(
      'inventory-no-errors',
      packageEvaluation.noErrors,
      'Package inventory reported no errors.',
      'Package inventory reported errors.'
    ),
  ];
  receipts.push(
    emit(
      outputDirectory,
      baseDraft(
        { ...args, 'reject-code': 'WIN_PACKAGE_INCOMPLETE' },
        'WIN-G05',
        g05Assertions,
        { inventory_error_count: inventory.errors?.length ?? -1 },
        ['reports/windows/phase-a/gates/WIN-G05.json', 'reports/windows/phase-a/gates/WIN-G05-package-inventory.json'],
        installerExists && unsigned ? { path: installerPath, signed: false, signature_subject: null } : null
      )
    )
  );
  assertPhaseAGatesPassed(receipts);
}

function preparePreconditionGates(args: Arguments): void {
  const outputDirectory = path.resolve(required(args, 'out-dir'));
  const crossOsDirectory = path.resolve(required(args, 'cross-os-dir'));
  const decisions = fs.readFileSync('reports/windows/phase-a/prebuild/phase-a-decisions.md', 'utf8');
  const stateTruth = fs.readFileSync('reports/windows/pilot-environment-redacted.md', 'utf8');
  const contractReview = fs.readFileSync('reports/windows/phase-a/prebuild/contract-review.md', 'utf8');
  const reviewStatus = fs.readFileSync('reports/windows/phase-a/prebuild/review-status.md', 'utf8');
  const fableReview = fs.readFileSync('reports/windows/phase-a/prebuild/fable-5-max-prebuild.md', 'utf8');
  const fablePostbuildReview = fs.readFileSync(
    'reports/windows/phase-a/postbuild/fable-5-max-win070-review.md',
    'utf8'
  );
  const codexPostbuildReview = fs.readFileSync('reports/windows/phase-a/postbuild/codex-adjudication.md', 'utf8');
  const glmPostbuildReview = fs.readFileSync('reports/windows/phase-a/postbuild/glm-5.2-win070-review.md', 'utf8');
  const documentChecks = evaluatePhaseAPreconditionDocuments({
    decisions,
    stateTruth,
    contractReview,
    reviewStatus,
    fableReview,
    fablePostbuildReview,
    codexPostbuildReview,
    glmPostbuildReview,
  });
  const documentMetrics = phaseAPreconditionMetrics(documentChecks);
  const receipts: WindowsGateReceiptV1[] = [];

  receipts.push(
    emit(
      outputDirectory,
      baseDraft(
        { ...args, 'reject-code': 'WIN_STATE_UNKNOWN' },
        'WIN-G00',
        [
          check(
            'phase-a-decisions-frozen',
            documentChecks.decisionsFrozen,
            'Phase A dependency, CI, and packaged-smoke decisions are frozen.',
            'Phase A decisions are not frozen.'
          ),
          check(
            'state-truth-complete',
            documentChecks.stateTruthComplete,
            'Windows state truth and support boundary are complete for Phase A.',
            'Windows state truth or support boundary is incomplete.'
          ),
        ],
        documentMetrics.state,
        ['reports/windows/phase-a/prebuild/phase-a-decisions.md', 'reports/windows/pilot-environment-redacted.md']
      )
    )
  );

  receipts.push(
    emit(
      outputDirectory,
      baseDraft(
        { ...args, 'reject-code': 'WIN_CONTRACT_REJECT' },
        'WIN-G01',
        [
          check(
            'controller-contract-pass',
            documentChecks.controllerContractPass,
            'Controller accepted the parent, child contracts, dependencies, gates, and rollback boundary.',
            'Controller contract review is missing or not PASS.'
          ),
          check(
            'independent-prebuild-review',
            documentChecks.independentPrebuildReviewPass,
            'Independent Fable pre-build review is recorded as PASS.',
            'Independent Fable pre-build PASS is not recorded.'
          ),
          check(
            'independent-postbuild-review',
            documentChecks.independentPostbuildReviewPass,
            'Fable and Codex post-build reviews converged after the final hotfix.',
            'Fable and Codex post-build convergence is missing.'
          ),
          check(
            'additional-glm-review-trace',
            documentChecks.additionalGlmReviewRecorded,
            'The bounded GLM review attempt is recorded as TIMEOUT_INCONCLUSIVE and is not counted as PASS.',
            'The bounded GLM review attempt is missing or misrepresented.'
          ),
        ],
        documentMetrics.reviews,
        [
          'reports/windows/phase-a/prebuild/contract-review.md',
          'reports/windows/phase-a/prebuild/review-status.md',
          'reports/windows/phase-a/prebuild/fable-5-max-prebuild.md',
          'reports/windows/phase-a/postbuild/fable-5-max-win070-review.md',
          'reports/windows/phase-a/postbuild/codex-adjudication.md',
          'reports/windows/phase-a/postbuild/glm-5.2-win070-review.md',
        ]
      )
    )
  );

  const markerFiles = fs.existsSync(crossOsDirectory)
    ? fs.readdirSync(crossOsDirectory).filter((name) => name.endsWith('.json'))
    : [];
  const markers = markerFiles.map(
    (name) =>
      JSON.parse(fs.readFileSync(path.join(crossOsDirectory, name), 'utf8')) as {
        schema_version?: string;
        runner_os?: string;
        source_commit?: string;
        status?: string;
        tsc?: string;
        lint?: string;
        format?: string;
        unit?: string;
        completion_sentinel?: string;
      }
  );
  const currentCommit = createWindowsGateReceipt(
    baseDraft(
      { ...args, 'reject-code': 'WIN_UNIT_FAILED' },
      'WIN-G02',
      [check('temporary', true, 'Temporary.', 'Temporary.')],
      {},
      []
    )
  ).source.commit;
  const expectedOs = ['Linux', 'macOS', 'Windows'];
  const exactOsSet = expectedOs.every((os) => markers.filter((marker) => marker.runner_os === os).length === 1);
  const allPass = markers.length === expectedOs.length && markers.every((marker) => marker.status === 'PASS');
  const sameCommit =
    markers.length === expectedOs.length && markers.every((marker) => marker.source_commit === currentCommit);
  const allSuites = markers.every(
    (marker) => marker.tsc === 'PASS' && marker.lint === 'PASS' && marker.format === 'PASS' && marker.unit === 'PASS'
  );
  const markerContractsValid = markers.every(
    (marker) =>
      marker.schema_version === 'command-eve-windows-cross-os/v1' &&
      marker.completion_sentinel === 'WIN_CROSS_OS_COMPLETE'
  );
  receipts.push(
    emit(
      outputDirectory,
      baseDraft(
        { ...args, 'reject-code': 'WIN_UNIT_FAILED' },
        'WIN-G02',
        [
          check(
            'cross-os-runner-set',
            exactOsSet,
            'Linux, macOS, and Windows each produced one marker.',
            'Cross-OS runner set is incomplete or duplicated.'
          ),
          check(
            'cross-os-suite-pass',
            markerContractsValid && allPass && allSuites,
            'Mandatory suites passed on all three operating systems.',
            'A cross-OS marker contract or mandatory suite failed or is missing.'
          ),
          check(
            'cross-os-source-commit',
            sameCommit,
            'All OS markers reference the proof source commit.',
            'OS markers reference a different source commit.'
          ),
        ],
        { marker_count: markers.length, runner_os: expectedOs.join(','), source_commit: currentCommit },
        markerFiles.map((name) => `reports/windows/phase-a/cross-os/${name}`)
      )
    )
  );
  assertPhaseAGatesPassed(receipts);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const mode = required(args, 'mode');
  if (mode === 'build') prepareBuildGates(args);
  else if (mode === 'preconditions') preparePreconditionGates(args);
  else throw new Error(`unsupported --mode: ${mode}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (error) {
    console.error(`[prepare-windows-phase-a-gates] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
