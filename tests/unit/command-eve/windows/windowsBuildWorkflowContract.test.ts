/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { WindowsGateReceiptV1 } from '@/process/commandEve/windows/types';
import productIdentity from '../../../../scripts/windows/productIdentity.cjs';
import {
  assertPhaseAGatesPassed,
  evaluatePhaseAPackageInventory,
  evaluatePhaseAPreconditionDocuments,
  hasExactTrimmedLine,
  phaseAPreconditionMetrics,
} from '../../../../scripts/windows/prepareWindowsPhaseAGates';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('Command EVE Windows build workflow contract', () => {
  it('keeps the reusable Windows build lane fail-closed', () => {
    const workflow = read('.github/workflows/_build-reusable.yml');

    expect(workflow).not.toContain('build failed but will not block the workflow');
    expect(workflow).toContain('if ($LASTEXITCODE -ne 0)');
    expect(workflow).toContain('throw "${{ matrix.platform }} build failed with exit code $LASTEXITCODE"');
    expect(workflow).toContain('BUILD_WITH_BUILDER_SELFTEST_FAIL');
  });

  it('uploads the complete Windows proof packet instead of installer-only output', () => {
    const reusable = read('.github/workflows/_build-reusable.yml');
    const manual = read('.github/workflows/build-manual.yml');

    expect(reusable).toContain('out/*-win-*.zip');
    expect(reusable).toContain('reports/windows/phase-a/gates/*.json');
    expect(reusable).toContain('if-no-files-found: error');
    expect(reusable).toContain('--require-python');
    expect(manual).toContain('upload_installers_only: false');
  });

  it('runs the Phase A proof on a fresh Windows runner with scoped test-seat auth', () => {
    const reusable = read('.github/workflows/_build-reusable.yml');
    const manual = read('.github/workflows/build-manual.yml');
    const harness = read('scripts/windows/run-phase-a-proof.ps1');

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
    expect(harness).toContain('-WorkingDirectory $hermesTurnWorkingDirectory');
    expect(harness).toContain("version('hermes-agent')");
    expect(harness).toContain('license_wire_profile_binding_verified');
    expect(harness).toContain('CreditProbeTimeoutSeconds = 300');
    expect(harness).toContain('copied Command EVE uninstaller /S');
    expect(harness).toContain('$info.Arguments = $RawArguments');
    expect(harness).toContain('-RawArguments "/S _?=$installDirectory"');
    expect(harness).not.toContain('\'/S\', "_?=$installDirectory"');
    expect(harness).toContain('scripts/windows/evaluateWindowsPhaseA.ts');
  });

  it('binds proof execution to one exact source commit and fails if the lifecycle is skipped', () => {
    const reusable = read('.github/workflows/_build-reusable.yml');
    const manual = read('.github/workflows/build-manual.yml');

    expect(manual).toContain('windows_phase_a_proof requires a full lowercase 40-character commit SHA');
    expect(manual).toContain('ref must equal the workflow trigger SHA');
    expect(reusable.match(/Verify exact Windows Phase A source/g)).toHaveLength(3);
    expect(reusable).toContain('test "$ACTUAL_SHA" = "$REQUESTED_REF"');
    expect(reusable).not.toContain('${ACTUAL_SHA,,}');
    expect(reusable).toContain("if: steps.phase-a-preconditions.outcome == 'success'");
    expect(reusable).toContain('pattern: windows-build-x64*');
    expect(reusable).toContain('Windows Phase A proof was requested but did not succeed');
  });

  it('parses the PowerShell harness and keeps proof postinstall failures fatal', () => {
    const reusable = read('.github/workflows/_build-reusable.yml');

    expect(reusable).toContain('[System.Management.Automation.Language.Parser]::ParseFile');
    expect(reusable).toContain('Windows Phase A PowerShell parse passed.');
    expect(reusable).not.toContain('bun run postinstall || true');
    expect(reusable).not.toContain('$Matches');
    expect(reusable).toContain('timeout-minutes: 120');
    expect(reusable).toContain('-BootstrapTimeoutSeconds 3600');
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

  it('uses Command EVE names in Windows package and install smoke paths', () => {
    const workflow = read('.github/workflows/pr-checks.yml');

    expect(workflow).toContain('Command EVE-*-win-x64.exe');
    expect(workflow).toContain('Programs\\\\Command EVE\\\\Command EVE.exe');
    expect(workflow).not.toMatch(/AionUi-\*-win/i);
    expect(workflow).not.toMatch(/Programs\\\\AionUi/i);
  });

  it('does not package native modules that are absent from dependencies', () => {
    const builder = read('packages/desktop/electron-builder.yml');

    expect(builder).not.toContain('node_modules/bcrypt/');
    expect(builder).not.toContain('node_modules/node-pty/');
    expect(builder).toContain('node_modules/better-sqlite3/');
  });

  it('activates a freshly installed Windows Hermes runtime without requiring an app restart', () => {
    const main = read('packages/desktop/src/index.ts');

    expect(main).toContain('shouldRestartWindowsBackendAfterRuntimeBootstrap');
    expect(main).toContain("surface: isWebUIMode ? 'webui' : 'desktop'");
    expect(main).toContain('await restartCommandEveBackendForSeat()');
    expect(main).toContain('commandEveBackendRestartAfterRuntimeBootstrap');
  });
});
