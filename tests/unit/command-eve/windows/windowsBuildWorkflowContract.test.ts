/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import type { WindowsGateReceiptV1 } from '@/process/commandEve/windows/types';
import productIdentity from '../../../../scripts/windows/productIdentity.cjs';
import {
  assertPhaseAGatesPassed,
  evaluatePhaseACrossOsParity,
  evaluatePhaseAPackageInventory,
  evaluatePhaseAPreconditionDocuments,
  hasExactTrimmedLine,
  phaseAPreconditionMetrics,
} from '../../../../scripts/windows/prepareWindowsPhaseAGates';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

type WorkflowStep = {
  if?: string;
  name?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowDocument = {
  env?: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      steps?: WorkflowStep[];
      strategy?: { matrix?: unknown };
      with?: Record<string, unknown>;
    }
  >;
};

function parseWorkflow(relativePath: string): WorkflowDocument {
  return YAML.parse(read(relativePath)) as WorkflowDocument;
}

function getWorkflowStep(document: WorkflowDocument, jobId: string, stepName: string): WorkflowStep {
  const step = document.jobs[jobId]?.steps?.find((candidate) => candidate.name === stepName);
  if (!step) throw new Error(`Missing workflow step ${jobId}/${stepName}`);
  return step;
}

describe('Command EVE Windows build workflow contract', () => {
  it('keeps the reusable Windows build lane fail-closed', () => {
    const workflow = read('.github/workflows/_build-reusable.yml');

    expect(workflow).not.toContain('build failed but will not block the workflow');
    expect(workflow).toContain('if ($LASTEXITCODE -ne 0)');
    expect(workflow).toContain('throw "${{ matrix.platform }} build failed with exit code $LASTEXITCODE"');
    expect(workflow).toContain('BUILD_WITH_BUILDER_SELFTEST_FAIL');
  });

  it('does not override the SHA-pinned AionHub source with an unmanifested tag', () => {
    const workflow = parseWorkflow('.github/workflows/_build-reusable.yml');

    expect(workflow.env?.AIONUI_HUB_TAG).toBeUndefined();
  });

  it('keeps Windows in the private pilot while public releases stay Mac/Linux only', () => {
    const reusable = read('.github/workflows/_build-reusable.yml');
    const releaseDocument = parseWorkflow('.github/workflows/build-and-release.yml');
    const distributionDocument = parseWorkflow('.github/workflows/release-distribute.yml');
    const packWebWorkflow = read('.github/workflows/pack-web-cli.yml');
    const packWebDocument = parseWorkflow('.github/workflows/pack-web-cli.yml');
    const assetPreparer = read('scripts/prepare-release-assets.sh');
    const releaseMatrix = releaseDocument.jobs['build-pipeline']?.with?.matrix;
    if (typeof releaseMatrix !== 'string') throw new Error('Release build matrix must be a JSON string');
    const releasePlatforms = (JSON.parse(releaseMatrix) as { include: Array<{ platform: string }> }).include.map(
      (entry) => entry.platform
    );
    const metadataStep = getWorkflowStep(distributionDocument, 'distribute', 'Validate updater metadata');

    expect(reusable).toContain('Resolve pinned Command EVE AionCore source');
    expect(reusable).toContain('Checkout pinned Command EVE AionCore source');
    expect(reusable).toContain('persist-credentials: false');
    expect(reusable).toContain('cargo build --locked --release --target "$AIONCORE_RUST_TARGET" -p aionui-app');
    expect(reusable).toContain('scripts/aioncoreSourceBuild.cjs bind');
    expect(releasePlatforms).toContain('macos-arm64');
    expect(releasePlatforms).not.toContain('windows-x64');
    expect(releasePlatforms).not.toContain('windows-arm64');
    expect(metadataStep.run).not.toContain('dist/latest.yml');
    expect(metadataStep.run).not.toContain('dist/latest-win-arm64.yml');
    expect(metadataStep.run).toContain('dist/latest-arm64-mac.yml');
    expect(metadataStep.run).toContain('metadata_version');
    expect(metadataStep.run).toContain('expected $VERSION');
    expect(
      distributionDocument.jobs.distribute.steps?.some((step) => step.name === 'Reject Windows pilot assets')
    ).toBe(true);
    const packWebJob = packWebDocument.jobs['pack-web-cli'];
    expect(packWebJob?.if).not.toContain('matrix.platform');
    expect(packWebJob?.strategy?.matrix).toEqual(expect.stringContaining('fromJSON(inputs.include_windows &&'));
    expect(packWebWorkflow).toContain('"platform":"win32"');
    expect(assetPreparer).toContain('Windows pilot artifacts must not enter the public release lane');
    expect(assetPreparer).not.toContain('for required in latest.yml');
    expect(assetPreparer).not.toContain('"win-x86_64"');
  });

  it('uploads the complete Windows proof packet instead of installer-only output', () => {
    const reusable = read('.github/workflows/_build-reusable.yml');
    const manual = read('.github/workflows/build-manual.yml');

    expect(reusable).toContain('out/*-win-*.zip');
    expect(reusable).toContain('reports/windows/phase-a/gates/*.json');
    expect(reusable).toContain('if-no-files-found: error');
    expect(reusable).toContain('--require-python');
    expect(reusable).toContain('--require-phase-a-feed-isolation');
    expect(manual).toContain('upload_installers_only: false');
  });

  it('runs the Phase A proof on a fresh Windows runner with scoped test-seat auth', () => {
    const reusable = read('.github/workflows/_build-reusable.yml');
    const reusableDocument = parseWorkflow('.github/workflows/_build-reusable.yml');
    const manual = read('.github/workflows/build-manual.yml');
    const harness = read('scripts/windows/run-phase-a-proof.ps1');
    const electronStep = getWorkflowStep(
      reusableDocument,
      'windows-phase-a-lifecycle',
      'Materialize Electron safeStorage runtime'
    );

    expect(reusable).toContain('windows-phase-a-lifecycle:');
    expect(reusable).toContain('runs-on: windows-2022');
    expect(reusable).toContain('scripts/windows/run-phase-a-proof.ps1');
    expect(reusable).toContain('COMMAND_EVE_PHASE_A_LICENSE');
    expect(reusable).toContain('reports/windows/phase-a/runtime/**');
    expect(manual).toContain('windows_phase_a_proof');
    expect(harness).toContain('Remove-Item Env:COMMAND_EVE_PHASE_A_LICENSE');
    expect(harness).toContain('-Environment $credentialEnvironment');
    expect(harness).toContain('Get-ExactTextFindingCount');
    expect(harness).toContain('Get-CommandLineScopedProcessIds');
    expect(harness).toContain('Runtime bootstrap heartbeat');
    expect(harness).toContain('runtime-bootstrap-first-launch-receipt.json');
    expect(harness).toContain('runtime-bootstrap-restart-receipt.json');
    expect(harness).toContain("$terminalReady = $status -eq 'ready'");
    expect(harness).toContain("Get-StageStatus -Receipt $receipt -StageId 'model'");
    expect(harness).toContain('Wait-ForCapturedStreams');
    expect(harness).toContain('captured stream drain timed out');
    expect(harness).toContain('-WorkingDirectory $hermesTurnWorkingDirectory');
    expect(harness).toContain("version('hermes-agent')");
    expect(harness).toContain('license_wire_profile_binding_verified');
    expect(harness).toContain('CreditProbeTimeoutSeconds = 300');
    expect(harness).toContain('copied Command EVE uninstaller /S');
    expect(harness).toContain('$info.Arguments = $RawArguments');
    expect(harness).toContain('-RawArguments "/S _?=$installDirectory"');
    expect(harness).not.toContain('\'/S\', "_?=$installDirectory"');
    expect(harness).toContain('Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop');
    expect(harness).toContain("Get-OptionalProperty -InputObject $properties -Name 'DisplayName' -Default ''");
    expect(harness).not.toContain(').DisplayName');
    expect(harness).toContain('scripts/windows/evaluateWindowsPhaseA.ts');
    expect(electronStep.run).toContain('node node_modules/electron/install.js');
    expect(electronStep.run).toContain('node_modules\\electron\\dist\\electron.exe');
    expect(electronStep.run).toContain('Electron safeStorage runtime is missing');
  });

  it('binds proof execution to one exact source commit and fails if the lifecycle is skipped', () => {
    const reusableDocument = parseWorkflow('.github/workflows/_build-reusable.yml');
    const manual = read('.github/workflows/build-manual.yml');

    expect(manual).toContain('windows_phase_a_proof requires a full lowercase 40-character commit SHA');
    expect(manual).toContain('ref must equal the workflow trigger SHA');
    for (const jobId of ['code-quality', 'build', 'windows-phase-a-lifecycle']) {
      const verifyStep = getWorkflowStep(reusableDocument, jobId, 'Verify exact Windows Phase A source');
      expect(verifyStep.env).toMatchObject({
        REQUESTED_REF: '${{ inputs.ref }}',
        TRIGGER_SHA: '${{ github.sha }}',
      });
      expect(verifyStep.run).toContain('test "$ACTUAL_SHA" = "$REQUESTED_REF"');
      expect(verifyStep.run).toContain('test "$ACTUAL_SHA" = "$TRIGGER_SHA"');
      expect(verifyStep.run).not.toContain('${ACTUAL_SHA,,}');
    }
    const summaryStep = getWorkflowStep(reusableDocument, 'build-summary', 'Write build summary');
    const lifecycleStep = getWorkflowStep(
      reusableDocument,
      'windows-phase-a-lifecycle',
      'Run packaged Windows Phase A proof'
    );
    const candidateStep = getWorkflowStep(
      reusableDocument,
      'windows-phase-a-lifecycle',
      'Download exact Windows candidate'
    );
    expect(lifecycleStep.if).toBe("steps.phase-a-preconditions.outcome == 'success'");
    expect(candidateStep.with).toMatchObject({ pattern: 'windows-build-x64*' });
    expect(summaryStep.env).toMatchObject({
      WINDOWS_PHASE_A_PROOF: '${{ inputs.windows_phase_a_proof }}',
      WINDOWS_PHASE_A_RESULT: '${{ needs.windows-phase-a-lifecycle.result }}',
    });
    expect(summaryStep.run).toContain(
      'if [ "$WINDOWS_PHASE_A_PROOF" = "true" ] && [ "$WINDOWS_PHASE_A_RESULT" != "success" ]; then'
    );
    expect(summaryStep.run).toMatch(/Windows Phase A proof was requested[\s\S]*exit 1/);
  });

  it('parses the PowerShell harness and keeps proof postinstall failures fatal', () => {
    const reusable = read('.github/workflows/_build-reusable.yml');
    const builderScript = read('scripts/build-with-builder.js');
    const builderPolicy = read('scripts/buildWithBuilderConfigCore.cjs');
    const harness = read('scripts/windows/run-phase-a-proof.ps1');
    const sharedBuilderConfig = YAML.parse(read('packages/desktop/electron-builder.yml')) as {
      publish?: { provider?: string; url?: string; publishAutoUpdate?: boolean };
    };
    const phaseABuilderConfig = YAML.parse(read('packages/desktop/electron-builder.phase-a.yml')) as {
      extends?: string;
      extraMetadata?: { commandEvePhaseAUnsignedProof?: boolean };
      publish?: { provider?: string; url?: string; publishAutoUpdate?: boolean };
    };

    expect(reusable).toContain('[System.Management.Automation.Language.Parser]::ParseFile');
    expect(reusable).toContain('Windows Phase A PowerShell parse passed.');
    expect(reusable).not.toContain('bun run postinstall || true');
    expect(reusable).not.toContain('$Matches');
    expect(reusable).toContain('timeout-minutes: 120');
    expect(reusable).toContain('-BootstrapTimeoutSeconds 2400');
    expect(reusable).toContain('-RestartBootstrapTimeoutSeconds 600');
    expect(reusable).toContain('Scope Defender exclusions to ephemeral proof paths');
    expect(reusable).toContain('COMMAND_EVE_PHASE_A_UNSIGNED_BUILD');
    expect(builderScript).toContain("require('./buildWithBuilderConfigCore.cjs')");
    expect(builderPolicy).toContain("'packages/desktop/electron-builder.phase-a.yml'");
    expect(builderScript).toContain("const publishArg = '--publish=never'");
    expect(builderScript).not.toContain('--config.publishAutoUpdate');
    expect(builderScript).not.toContain('--config.extraMetadata.commandEvePhaseAUnsignedProof');
    expect(phaseABuilderConfig).toEqual({
      extends: 'packages/desktop/electron-builder.yml',
      extraMetadata: { commandEvePhaseAUnsignedProof: true },
      publish: {
        provider: 'generic',
        url: 'https://phase-a.invalid',
        publishAutoUpdate: true,
      },
    });
    expect(sharedBuilderConfig.publish).toEqual({
      provider: 'generic',
      url: 'https://eve-update-proxy.commandeve.workers.dev',
      publishAutoUpdate: true,
    });
    expect(harness.match(/\$textExtensions = @\('', '\.cfg', '\.conf', '\.csv', '\.env'/g)).toHaveLength(2);
    expect(harness.match(/\$isDotEnv = \$file\.Name -ieq '\.env'/g)).toHaveLength(2);
    expect(harness).toContain("$file.Name -ceq 'RECORD'");
    expect(harness).toContain("$file.Directory.Name.EndsWith('.dist-info'");
    expect(harness.match(/if \(\$isPythonRecord\) \{ continue \}/g)).toHaveLength(1);
    expect(
      harness.match(/-not \$isDotEnv -and \$file\.Extension\.ToLowerInvariant\(\) -notin \$textExtensions/g)
    ).toHaveLength(2);
  });

  it('loads every TypeScript Phase A proof entrypoint without executing its CLI', async () => {
    await expect(import('../../../../scripts/windows/evaluateWindowsPhaseA')).resolves.toBeDefined();
    await expect(import('../../../../scripts/windows/provisionPhaseATestSeat')).resolves.toBeDefined();
  });

  it('does not accept pass words embedded in explanatory prose as gate verdicts', () => {
    expect(hasExactTrimmedLine('The result is not CONTRACT_PASS.', 'Controller verdict: `CONTRACT_PASS`')).toBe(false);
    expect(hasExactTrimmedLine('  Controller verdict: `CONTRACT_PASS`  ', 'Controller verdict: `CONTRACT_PASS`')).toBe(
      true
    );
  });

  it('rejects missing exact precondition sentinels and any non-pass prepared gate', () => {
    const validDocuments = {
      decisions: 'Completion sentinel: `PHASE_A_DECISIONS_FROZEN`',
      stateTruth: 'Verdict: `PASS_FOR_PHASE_A`\nCompletion sentinel: `WIN_STATE_TRUTH_COMPLETE`',
      contractReview:
        'Controller verdict: `CONTRACT_PASS`\nCompletion sentinel: `WIN_PHASE_A_CONTRACT_REVIEW_COMPLETE`',
      reviewStatus: '## Fable 5 Max\nStatus: PASS\nCompletion sentinel: `PHASE_A_PREBUILD_REVIEW_RECORDED`',
      fableReview: 'FABLE_PHASE_A_PREBUILD_COMPLETE',
      fablePostbuildReview:
        'Delta completion sentinel: `FABLE_PHASE_A_GATE_DELTA_CONVERGED`\nCompletion sentinel: `FABLE_PHASE_A_POSTFIX_CONVERGED`',
      codexPostbuildReview: 'Completion sentinel: `WIN_PHASE_A_POSTBUILD_REVIEW_CONVERGED`',
      glmPostbuildReview: 'Status: `TIMEOUT_INCONCLUSIVE`\nCompletion sentinel: `GLM_PHASE_A_POSTFIX_REVIEW_TIMEOUT`',
    };

    expect(evaluatePhaseAPreconditionDocuments(validDocuments)).toEqual({
      decisionsFrozen: true,
      stateTruthComplete: true,
      controllerContractPass: true,
      independentPrebuildReviewPass: true,
      independentPostbuildReviewPass: true,
      additionalGlmReviewRecorded: true,
    });
    expect(
      evaluatePhaseAPreconditionDocuments({ ...validDocuments, fableReview: 'review still running' })
        .independentPrebuildReviewPass
    ).toBe(false);
    expect(
      evaluatePhaseAPreconditionDocuments({
        ...validDocuments,
        fablePostbuildReview: 'Fable said Completion sentinel: `FABLE_PHASE_A_POSTFIX_CONVERGED` in explanatory prose.',
      }).independentPostbuildReviewPass
    ).toBe(false);
    expect(
      evaluatePhaseAPreconditionDocuments({ ...validDocuments, codexPostbuildReview: 'adjudication pending' })
        .independentPostbuildReviewPass
    ).toBe(false);
    expect(
      evaluatePhaseAPreconditionDocuments({
        ...validDocuments,
        glmPostbuildReview: 'Completion sentinel: `GLM_PHASE_A_POSTFIX_REVIEW_COMPLETE`',
      }).additionalGlmReviewRecorded
    ).toBe(false);
    expect(
      phaseAPreconditionMetrics(
        evaluatePhaseAPreconditionDocuments({
          ...validDocuments,
          stateTruth: 'state review pending',
          codexPostbuildReview: 'adjudication pending',
          glmPostbuildReview: 'GLM review still running',
        })
      )
    ).toEqual({
      state: { critical_unknown_count: 1 },
      reviews: {
        contract_review: 'CONTRACT_PASS',
        fable_prebuild: 'PASS',
        fable_codex_postbuild: 'NOT_RECORDED',
        glm_postbuild: 'NOT_RECORDED',
      },
    });
    expect(() => assertPhaseAGatesPassed([{ gate_id: 'WIN-G00', status: 'REJECT' } as WindowsGateReceiptV1])).toThrow(
      'Phase A gate preparation rejected: WIN-G00'
    );
  });

  it('uses the canonical Windows runtime key in the package gate', () => {
    const preparer = read('scripts/windows/prepareWindowsPhaseAGates.ts');

    expect(productIdentity.WINDOWS_RUNTIME_KEY).toBe('win32-x64');
    expect(preparer).toContain('productIdentity.WINDOWS_RUNTIME_KEY');
    expect(preparer).not.toContain("inventory.runtime_keys[0] === 'windows-x64'");
  });

  it('accepts a producer-shaped package inventory only with the canonical runtime and installer hash', () => {
    const inventory = {
      status: 'PASS',
      artifacts: [{ path: 'out/Command EVE-1.7.92-win-x64.exe', sha256: 'a'.repeat(64) }],
      runtime_keys: ['win32-x64'],
      bundled_python: { interpreter: { path: 'python.exe' }, manifest_receipt: { status: 'PASS' } },
      errors: [],
    };

    expect(evaluatePhaseAPackageInventory(inventory, 'Command EVE-1.7.92-win-x64.exe', 'a'.repeat(64))).toEqual({
      inventoryPass: true,
      singleWindowsRuntime: true,
      bundledPythonProvenance: true,
      installerHashMatches: true,
      noErrors: true,
    });
    expect(
      evaluatePhaseAPackageInventory(
        { ...inventory, runtime_keys: ['windows-x64'] },
        inventory.artifacts[0].path,
        'a'.repeat(64)
      ).singleWindowsRuntime
    ).toBe(false);
  });

  it('seeds safeStorage with the packaged app profile before Electron becomes ready', () => {
    const seeder = read('scripts/windows/seedPhaseALicense.cjs');
    const setPathOffset = seeder.indexOf("app.setPath('userData', profileRoot)");
    const readyOffset = seeder.indexOf('await app.whenReady()');

    expect(setPathOffset).toBeGreaterThan(0);
    expect(readyOffset).toBeGreaterThan(setPathOffset);
    expect(seeder).toContain('profile_binding_verified: profileBindingVerified');
  });

  it('requires all three operating systems and every Phase A receipt', () => {
    const reusable = read('.github/workflows/_build-reusable.yml');
    const preparer = read('scripts/windows/prepareWindowsPhaseAGates.ts');
    const evaluator = read('scripts/windows/evaluateWindowsPhaseA.ts');

    expect(reusable).toContain('["ubuntu-latest","macos-14","windows-2022"]');
    expect(preparer).toContain("const expectedOs = ['Linux', 'macOS', 'Windows']");
    expect(reusable).toContain('product_version:productVersion');
    expect(reusable).toContain('command_eve_version:commandEveVersion');
    expect(preparer).toContain("'cross-os-product-version'");
    expect(preparer).toContain('WIN_PHASE_A_CONTRACT_REVIEW_COMPLETE');
    expect(preparer).toContain('FABLE_PHASE_A_POSTFIX_CONVERGED');
    expect(preparer).toContain('FABLE_PHASE_A_GATE_DELTA_CONVERGED');
    expect(preparer).toContain('WIN_PHASE_A_POSTBUILD_REVIEW_CONVERGED');
    expect(preparer).toContain('GLM_PHASE_A_POSTFIX_REVIEW_TIMEOUT');
    expect(evaluator).toContain("['WIN-G06', evaluatePhaseAInstallLifecycle(raw)]");
    expect(evaluator).toContain("['WIN-G06T', evaluatePhaseAHermesTurnHolder(raw)]");
    expect(evaluator).toContain("['WIN-G07', evaluatePhaseACloudTurn(raw)]");
    expect(evaluator).toContain("gate_id: 'WIN-G08'");
    expect(evaluator).toContain("console.log('WINDOWS_X64_PROOF')");
  });

  it('rejects a mixed Mac/Windows source commit or product version', () => {
    const commit = 'a'.repeat(40);
    const marker = (runnerOs: string) => ({
      schema_version: 'command-eve-windows-cross-os/v1',
      runner_os: runnerOs,
      source_commit: commit,
      product_version: '1.8.11',
      command_eve_version: 'v1.8.11',
      status: 'PASS',
      tsc: 'PASS',
      lint: 'PASS',
      format: 'PASS',
      unit: 'PASS',
      completion_sentinel: 'WIN_CROSS_OS_COMPLETE',
    });
    const markers = [marker('Linux'), marker('macOS'), marker('Windows')];

    expect(evaluatePhaseACrossOsParity(markers, commit, '1.8.11', 'v1.8.11')).toMatchObject({
      exactOsSet: true,
      sameCommit: true,
      sameProductVersion: true,
    });
    const mixedVersionMarkers = [...markers];
    mixedVersionMarkers[2] = { ...mixedVersionMarkers[2], product_version: '1.8.10' };
    expect(evaluatePhaseACrossOsParity(mixedVersionMarkers, commit, '1.8.11', 'v1.8.11').sameProductVersion).toBe(
      false
    );
    const mixedCommitMarkers = [...markers];
    mixedCommitMarkers[1] = { ...mixedCommitMarkers[1], source_commit: 'b'.repeat(40) };
    expect(evaluatePhaseACrossOsParity(mixedCommitMarkers, commit, '1.8.11', 'v1.8.11').sameCommit).toBe(false);
  });

  it('uses Command EVE names in Windows package and install smoke paths', () => {
    const workflow = read('.github/workflows/pr-checks.yml');

    expect(workflow).toContain('Command EVE-*-win-x64.exe');
    expect(workflow).toContain('Programs\\\\Command EVE\\\\Command EVE.exe');
    expect(workflow).not.toMatch(/AionUi-\*-win/i);
    expect(workflow).not.toMatch(/Programs\\\\AionUi/i);
  });

  it('packages only native modules that are declared runtime dependencies', () => {
    const builder = read('packages/desktop/electron-builder.yml');
    const packageJson = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };

    expect(builder).not.toContain('node_modules/bcrypt/');
    expect(packageJson.dependencies?.['node-pty']).toBe('1.1.0');
    expect(builder).toContain('node_modules/node-pty/');
    expect(builder).toContain('node_modules/better-sqlite3/');
  });

  it('activates a freshly installed Windows Hermes runtime without requiring an app restart', () => {
    const main = read('packages/desktop/src/index.ts');

    expect(main).toContain('shouldRestartWindowsBackendAfterRuntimeBootstrap');
    expect(main).toContain("surface: isWebUIMode ? 'webui' : 'desktop'");
    expect(main).toContain('restartCommandEveBackendAfterWindowsBootstrap(restartLease)');
    expect(main).toContain('queueWaitTimeoutMs: COMMAND_EVE_DEFERRED_RUNTIME_RESTART_QUEUE_WAIT_MS');
    expect(main).toContain('commandEveBackendRestartAfterRuntimeBootstrap');
  });
});
