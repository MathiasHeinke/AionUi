/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { validatePhaseBEvidence } from '../../../../.github/scripts/windows/phase-b/validate-phase-b-evidence';
import { validatePhaseBRunBinding } from '../../../../.github/scripts/windows/phase-b/validate-phase-b-run-binding';

const temporaryDirectories: string[] = [];
const SOURCE_REF = 'codex/command-eve-windows-phase-b-bootstrap';
const SOURCE_COMMIT = 'a'.repeat(40);
const WORKFLOW_COMMIT = 'b'.repeat(40);
const WORKFLOW_BLOB = 'c'.repeat(40);
const RUNNER_BINDING = 'd'.repeat(32);
const RUNNER_NAME = `command-eve-phase-b-lowmem-${RUNNER_BINDING.slice(0, 12)}`;
const RUNNER_ID = 24681012;
const JIT_CONFIG_SHA256 = 'e'.repeat(64);
const JIT_CONFIG_BYTES = 512;
const RUN_ID = '123456789';
const RUN_REF = `refs/tags/command-eve-phase-b-${RUNNER_BINDING}`;
const WORKFLOW_REF = `MathiasHeinke/command-eve-windows-lab/.github/workflows/windows-phase-b-lab.yml@${RUN_REF}`;

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-phase-b-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Windows Phase B bootstrap contract', () => {
  it('collects Windows 11 x64 and security facts without user or machine identity', () => {
    const collector = read('.github/scripts/windows/phase-b/collect-machine-facts.ps1');

    expect(collector).toContain('Win32_OperatingSystem');
    expect(collector).toContain('Win32_Processor');
    expect(collector).toContain("[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')");
    expect(collector).toContain('Get-MpComputerStatus');
    expect(collector).toContain('IsTamperProtected');
    expect(collector).toContain('Get-NetFirewallProfile');
    expect(collector).toContain('EnableSmartScreen');
    expect(collector).toContain('WIN_PHASE_B_MACHINE_FACTS_COMPLETE');
    expect(collector).not.toMatch(/computer_name\s*=/i);
    expect(collector).not.toMatch(/user_name\s*=/i);
  });

  it('keeps the JIT credential one-use, emits heartbeats, redacts diagnostics, and removes the process tree', () => {
    const runner = read('.github/scripts/windows/phase-b/run-jit-runner.ps1');

    expect(runner).toContain("Join-Path $env:LOCALAPPDATA 'CommandEVE\\jit-input'");
    expect(runner).toContain('JIT_CONFIG_OUTSIDE_PRIVATE_INPUT_ROOT');
    expect(runner).toContain('Remove-Item -LiteralPath $absoluteJitConfigPath -Force');
    expect(runner).toContain('--jitconfig');
    expect(runner).toContain('JIT runner heartbeat');
    expect(runner).toContain('taskkill.exe /PID $RootPid /T /F');
    expect(runner).toContain('.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0');
    expect(runner).toContain("$credentialFileNames = @('.runner', '.credentials', '.credentials_rsaparams')");
    expect(runner).toContain('Get-RunnerScopedProcessIds');
    expect(runner).toContain('$cleanupRunnerPid = 0');
    expect(runner).toContain('-RootPid $cleanupRunnerPid');
    expect(runner).toContain('[REDACTED_JIT_CONFIG]');
    expect(runner).toContain('[REDACTED_CREDENTIAL]');
    expect(runner).toContain('Remove-Item -LiteralPath $runnerRoot -Recurse -Force');
    expect(runner).toContain('WIN_PHASE_B_JIT_RUNNER_CLEANUP_COMPLETE');
    expect(runner).not.toContain('GITHUB_TOKEN');
    expect(runner).not.toContain('GH_TOKEN');
    expect(runner).not.toMatch(/\.Contains\([^\n]+StringComparison/);
    expect(runner).not.toContain('2>&1');
  });

  it('downloads one pinned official Windows x64 runner archive and verifies its published digest', () => {
    const downloader = read('.github/scripts/windows/phase-b/download-runner-archive.ps1');

    expect(downloader).toContain("$runnerVersion = '2.335.1'");
    expect(downloader).toContain("$runnerSha256 = 'eb65c95277af42bcf3778a799c41359d224ba2a67b4de26b7cea1729b09c803d'");
    expect(downloader).toContain('actions-runner-win-x64-$runnerVersion.zip');
    expect(downloader).toContain('Get-FileHash -LiteralPath $temporaryArchivePath -Algorithm SHA256');
    expect(downloader).toContain('WIN_PHASE_B_RUNNER_ARCHIVE_COMPLETE');
    expect(downloader).not.toContain('actions-runner-win-arm64');
    expect(downloader).not.toContain('/latest/');
  });

  it('binds JIT issuance to separate private workflow and public source commits without printing the credential', () => {
    const controller = read('.github/scripts/windows/phase-b/generate-jit-config.sh');

    expect(controller).toContain('if [[ "$visibility" != \'private\' ]]');
    expect(controller).toContain('repos/$repository/commits/$workflow_commit');
    expect(controller).toContain('repos/$source_repository/commits/$source_commit');
    expect(controller).toContain('repos/$source_repository/git/ref/heads/$source_ref');
    expect(controller).toContain('if [[ "$source_visibility" != \'public\' ]]');
    expect(controller).toContain('git -C "$repo_root" rev-parse HEAD');
    expect(controller).toContain('git -C "$repo_root" status --porcelain');
    expect(controller).toContain('git hash-object "$workflow_template"');
    expect(controller).toContain('windows-phase-b-lab.workflow.yml?ref=$source_commit');
    expect(controller).toContain('windows-phase-b-lab.yml?ref=$workflow_commit');
    expect(controller).toContain('"$source_workflow_blob" != "$local_workflow_blob"');
    expect(controller).toContain('"$control_workflow_blob" != "$local_workflow_blob"');
    expect(controller).toContain('openssl rand -hex 16');
    expect(controller).toContain('binding_label="ceve-bind-$runner_binding"');
    expect(controller).toContain('Refusing to overwrite an existing JIT config or issuance receipt.');
    expect(controller).toContain('actions/runners/generate-jitconfig');
    expect(controller).toContain('.runner.id | select(type == "number" and . > 0)');
    expect(controller).toContain('jit_config_sha256');
    expect(controller).toContain('actions/runners/$revoke_runner_id');
    expect(controller).toContain('X-GitHub-Api-Version: 2026-03-10');
    expect(controller).toContain('chmod 600 "$jit_temp"');
    expect(controller).toContain('command-eve-windows-phase-b-jit-issuance/v2');
    expect(controller).toContain('credential_delivery: "encoded_jit_config_once"');
    expect(controller).toContain("expected_repository='MathiasHeinke/command-eve-windows-lab'");
    expect(controller).toContain("expected_source_repository='MathiasHeinke/AionUi'");
    expect(
      controller
        .split('\n')
        .filter((line) => line.trimStart().startsWith('printf') && line.includes('encoded_jit_config'))
    ).toEqual([`printf '%s' "$encoded_jit_config" >"$jit_temp"`]);
    expect(controller).toContain('--workflow-commit PRIVATE_WORKFLOW_40_HEX_SHA');
    expect(controller).toContain('--source-repository OWNER/PUBLIC_SOURCE_REPO');
    expect(controller).toContain('--source-ref PUBLIC_SOURCE_BRANCH');
    expect(controller.indexOf('mv -f "$issuance_temp" "$issuance_out"')).toBeLessThan(
      controller.indexOf('mv -f "$jit_temp" "$jit_config_out"')
    );
  });

  it('dispatches the private workflow from a unique exact-commit tag and records the consuming run', () => {
    const dispatcher = read('.github/scripts/windows/phase-b/dispatch-private-workflow.sh');

    expect(dispatcher).toContain('--arg display_prefix "Command EVE Phase B $memory_class "');
    expect(dispatcher).toContain('(.display_title | startswith($display_prefix))');
    expect(dispatcher).not.toContain('[.workflow_runs[] | select(.status != "completed")]');
    expect(dispatcher).toContain('--jit-config /secure/path/jit-config.txt');
    expect(dispatcher).toContain('issued_runner_identity_matches');
    expect(dispatcher).toContain('([.labels[]?.name] | index($binding_label)) != null');
    expect(dispatcher).toContain("registered_runner_status\" == 'online'");
    expect(dispatcher).toContain("registered_runner_busy\" == 'false'");
    expect(dispatcher).toContain('tag_name="command-eve-phase-b-$runner_binding"');
    expect(dispatcher).toContain('"repos/$control_repository/git/refs"');
    expect(dispatcher).toContain('"repos/$control_repository/actions/workflows/$workflow_file/dispatches"');
    expect(dispatcher).toContain('.display_title == $display_title');
    expect(dispatcher).toContain('dispatch_submitted=1');
    expect(dispatcher).toContain('tag_created == 1 && dispatch_submitted == 0');
    expect(dispatcher).toContain('actions/runs/$run_id/cancel');
    expect(dispatcher).toContain('Phase B workflow heartbeat');
    expect(dispatcher).toContain('gh run download "$run_id"');
    expect(dispatcher).toContain('--name "$artifact_name"');
    expect(dispatcher).toContain('validate-phase-b-run-binding.ts');
    expect(dispatcher).toContain('WIN_PHASE_B_JIT_RUN_BINDING_COMPLETE');
    expect(dispatcher.indexOf('trap pre_dispatch_cleanup EXIT')).toBeLessThan(
      dispatcher.indexOf('.schema_version == "command-eve-windows-phase-b-jit-issuance/v2"')
    );
    expect(dispatcher.indexOf('trap pre_dispatch_cleanup EXIT')).toBeLessThan(
      dispatcher.indexOf('actual_jit_config_sha256=')
    );
    const runnerIdentityMismatchBranch = dispatcher.slice(
      dispatcher.indexOf('issued GitHub runner identity or labels do not match'),
      dispatcher.indexOf('registered_runner_status=')
    );
    expect(runnerIdentityMismatchBranch).not.toContain('revoke_issued_runner');
    expect(dispatcher).toContain('command-eve-windows-phase-b-dispatch/v1');
    expect(dispatcher).toContain('WIN_PHASE_B_PRIVATE_DISPATCH_COMPLETE');
    expect(dispatcher).not.toContain('GITHUB_TOKEN');
    expect(dispatcher).not.toContain('GH_TOKEN');
  });

  it('keeps the active runner workflow inert in source and fail-closed for the private mirror', () => {
    const relativePath = '.github/scripts/windows/phase-b/windows-phase-b-lab.workflow.yml';
    const workflowText = read(relativePath);
    const workflow = YAML.parse(workflowText) as {
      permissions?: Record<string, string>;
      on?: Record<string, unknown>;
      jobs?: Record<string, { 'runs-on'?: unknown }>;
    };
    const publisher = read('.github/scripts/windows/phase-b/publish-private-workflow.sh');

    expect(relativePath).not.toContain('.github/workflows/');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.on ?? {})).toEqual(['workflow_dispatch']);
    expect(workflow.jobs?.bootstrap?.['runs-on']).toBe('${{ fromJSON(needs.prepare.outputs.runner_labels) }}');
    expect(workflowText).toContain('EXPECTED_CONTROL_REPOSITORY: MathiasHeinke/command-eve-windows-lab');
    expect(workflowText).toContain('EXPECTED_SOURCE_REPOSITORY: MathiasHeinke/AionUi');
    expect(workflowText).toContain('test "$CONTROL_REPOSITORY_PRIVATE" = "true"');
    expect(workflowText).toContain('[[ "$WORKFLOW_COMMIT" =~ ^[0-9a-f]{40}$ ]]');
    expect(workflowText).toContain('test "$WORKFLOW_COMMIT" = "$INPUT_WORKFLOW_COMMIT"');
    expect(workflowText).toContain('ceve-bind-%s');
    expect(workflowText).toContain('group: command-eve-phase-b-${{ inputs.memory_class }}');
    expect(workflowText).toContain(
      'run-name: Command EVE Phase B ${{ inputs.memory_class }} ${{ inputs.runner_binding }}'
    );
    expect(workflowText).toContain('$env:RUNNER_NAME -cne $env:EXPECTED_RUNNER_NAME');
    expect(workflowText).toContain('refs/tags/command-eve-phase-b-$($env:EXPECTED_RUNNER_BINDING)');
    expect(workflowText).toContain('repository: MathiasHeinke/AionUi');
    expect(workflowText).not.toContain('test "$SOURCE_COMMIT" = "$WORKFLOW_COMMIT"');
    expect(workflowText).toContain('persist-credentials: false');
    expect(workflowText).toContain('Git for Windows is required before the JIT workflow starts.');
    expect(workflowText).toContain('bun-version: 1.3.14');
    expect(workflowText).toContain('actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5');
    expect(workflowText).toContain('oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6');
    expect(workflowText).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
    expect(workflowText).not.toContain('pull_request:');
    expect(workflowText).not.toContain('shell: pwsh');
    expect(workflowText).not.toContain('Defender exclusions');
    expect(publisher).toContain('if [[ "$visibility" != \'private\' ]]');
    expect(publisher).toContain("expected_repository='MathiasHeinke/command-eve-windows-lab'");
    expect(publisher).toContain("target='.github/workflows/windows-phase-b-lab.yml'");
    expect(read('.github/scripts/windows/phase-b/collect-runner-policy.ps1')).toContain('$env:GITHUB_EVENT_PATH');
  });

  it('writes deterministic PASS receipts for a hardened low-memory lab machine', () => {
    const directory = makeTemporaryDirectory();
    const machineFactsPath = path.join(directory, 'machine.json');
    const runnerPolicyPath = path.join(directory, 'runner.json');
    const outputDirectory = path.join(directory, 'receipts');
    fs.writeFileSync(
      machineFactsPath,
      JSON.stringify({
        schema_version: 'command-eve-windows-phase-b-machine-facts/v1',
        collected_at: '2026-07-15T16:00:00.000Z',
        collection_errors: [],
        host: {
          os_caption: 'Microsoft Windows 11 Enterprise',
          os_version: '10.0.26100',
          os_build: '26100',
          product_type: 1,
          native_architecture: 'AMD64',
          process_architecture: 'X64',
          processor_architecture_codes: [9, 9],
          ram_bytes: 8 * 1024 ** 3,
          logical_cpu_count: 2,
        },
        user: {
          is_local_administrator: false,
          token_is_elevated: false,
          uac_enabled: true,
          secure_desktop_enabled: true,
        },
        security: {
          defender_service_running: true,
          defender_antivirus_enabled: true,
          defender_real_time_protection_enabled: true,
          defender_behavior_monitor_enabled: true,
          defender_ioav_protection_enabled: true,
          defender_tamper_protected: true,
          smart_screen_policy_enabled: true,
          smart_screen_shell_mode: 'Warn',
          smart_screen_app_reputation_enabled: true,
          process_creation_command_line_audit_enabled: null,
          firewall_domain_enabled: true,
          firewall_private_enabled: true,
          firewall_public_enabled: true,
        },
      })
    );
    fs.writeFileSync(
      runnerPolicyPath,
      JSON.stringify({
        schema_version: 'command-eve-windows-phase-b-runner-policy/v2',
        repository: { full_name: 'MathiasHeinke/command-eve-windows-lab', visibility: 'private' },
        dispatch: {
          event_name: 'workflow_dispatch',
          source_repository: 'MathiasHeinke/AionUi',
          source_ref: SOURCE_REF,
          source_commit: SOURCE_COMMIT,
          workflow_commit: WORKFLOW_COMMIT,
          runner_binding: RUNNER_BINDING,
          expected_runner_name: RUNNER_NAME,
          actual_runner_name: RUNNER_NAME,
          run_id: RUN_ID,
          run_attempt: 1,
          ref: RUN_REF,
          ref_type: 'tag',
          workflow_ref: WORKFLOW_REF,
          pull_request_from_fork: false,
          permissions: { contents: 'read', id_token: 'none' },
        },
        runner: {
          mode: 'jit',
          max_jobs: 1,
          labels: [
            'self-hosted',
            'Windows',
            'X64',
            'command-eve-phase-b',
            'phase-b-lowmem',
            `ceve-bind-${RUNNER_BINDING}`,
          ],
          work_folder: '_work',
          preexisting_credential_file_count: 0,
          controller_token_present: false,
          production_secrets_available: false,
          root_is_disposable: true,
          diagnostics_externalized: true,
          credential_delivery: 'encoded_jit_config_once',
        },
      })
    );

    const outcome = validatePhaseBEvidence({
      machineFactsPath,
      runnerPolicyPath,
      memoryClass: 'lowmem-8gb',
      expectedControlRepository: 'MathiasHeinke/command-eve-windows-lab',
      expectedSourceRepository: 'MathiasHeinke/AionUi',
      expectedSourceRef: SOURCE_REF,
      expectedSourceCommit: SOURCE_COMMIT,
      expectedWorkflowCommit: WORKFLOW_COMMIT,
      expectedRunnerBinding: RUNNER_BINDING,
      expectedRunnerName: RUNNER_NAME,
      outputDirectory,
      nowMs: Date.parse('2026-07-15T16:05:00.000Z'),
    });

    expect(outcome.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(outputDirectory, 'bootstrap-summary.json'), 'utf8'))).toMatchObject({
      status: 'PASS',
      completion_sentinel: 'WIN_PHASE_B_BOOTSTRAP_VALIDATION_PASS',
    });

    const rejectedMachine = JSON.parse(fs.readFileSync(machineFactsPath, 'utf8')) as {
      collection_errors: string[];
    };
    rejectedMachine.collection_errors = ['security:defender-status'];
    fs.writeFileSync(machineFactsPath, JSON.stringify(rejectedMachine));
    const rejectOutputDirectory = path.join(directory, 'reject-receipts');
    const rejected = validatePhaseBEvidence({
      machineFactsPath,
      runnerPolicyPath,
      memoryClass: 'lowmem-8gb',
      expectedControlRepository: 'MathiasHeinke/command-eve-windows-lab',
      expectedSourceRepository: 'MathiasHeinke/AionUi',
      expectedSourceRef: SOURCE_REF,
      expectedSourceCommit: SOURCE_COMMIT,
      expectedWorkflowCommit: WORKFLOW_COMMIT,
      expectedRunnerBinding: RUNNER_BINDING,
      expectedRunnerName: RUNNER_NAME,
      outputDirectory: rejectOutputDirectory,
      nowMs: Date.parse('2026-07-15T16:05:00.000Z'),
    });

    expect(rejected.ok).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(rejectOutputDirectory, 'bootstrap-summary.json'), 'utf8'))
    ).toMatchObject({
      status: 'REJECT',
      completion_sentinel: 'WIN_PHASE_B_BOOTSTRAP_VALIDATION_REJECT',
    });
  });

  it('accepts one matching issuance, dispatch, and runner receipt and rejects run substitution', () => {
    const directory = makeTemporaryDirectory();
    const issuancePath = path.join(directory, 'issuance.json');
    const dispatchPath = path.join(directory, 'dispatch.json');
    const runnerPath = path.join(directory, 'runner.json');
    const outputPath = path.join(directory, 'binding.json');
    const issuance = {
      schema_version: 'command-eve-windows-phase-b-jit-issuance/v2',
      control_repository: { full_name: 'MathiasHeinke/command-eve-windows-lab', visibility: 'private' },
      workflow_commit: WORKFLOW_COMMIT,
      workflow_template_blob: WORKFLOW_BLOB,
      source_repository: { full_name: 'MathiasHeinke/AionUi', visibility: 'public' },
      source_ref: SOURCE_REF,
      source_commit: SOURCE_COMMIT,
      memory_class: 'lowmem-8gb',
      runner_binding: RUNNER_BINDING,
      runner_name: RUNNER_NAME,
      runner_id: RUNNER_ID,
      jit_config_sha256: JIT_CONFIG_SHA256,
      jit_config_bytes: JIT_CONFIG_BYTES,
      status: 'PASS',
      completion_sentinel: 'WIN_PHASE_B_JIT_ISSUANCE_COMPLETE',
    };
    const dispatch = {
      schema_version: 'command-eve-windows-phase-b-dispatch/v1',
      control_repository: 'MathiasHeinke/command-eve-windows-lab',
      workflow_commit: WORKFLOW_COMMIT,
      workflow_template_blob: WORKFLOW_BLOB,
      source_repository: 'MathiasHeinke/AionUi',
      source_ref: SOURCE_REF,
      source_commit: SOURCE_COMMIT,
      memory_class: 'lowmem-8gb',
      runner_binding: RUNNER_BINDING,
      runner_name: RUNNER_NAME,
      runner_id: RUNNER_ID,
      jit_config_sha256: JIT_CONFIG_SHA256,
      jit_config_bytes: JIT_CONFIG_BYTES,
      run_ref: RUN_REF,
      workflow_ref: WORKFLOW_REF,
      run_id: RUN_ID,
      run_attempt: 1,
      status: 'PASS',
      completion_sentinel: 'WIN_PHASE_B_PRIVATE_DISPATCH_COMPLETE',
    };
    const runner = {
      schema_version: 'command-eve-windows-phase-b-runner-policy-result/v2',
      control_repository: 'MathiasHeinke/command-eve-windows-lab',
      source_repository: 'MathiasHeinke/AionUi',
      source_ref: SOURCE_REF,
      source_commit: SOURCE_COMMIT,
      workflow_commit: WORKFLOW_COMMIT,
      memory_class: 'lowmem-8gb',
      runner_binding: RUNNER_BINDING,
      runner_name: RUNNER_NAME,
      run_id: RUN_ID,
      run_attempt: 1,
      run_ref: RUN_REF,
      workflow_ref: WORKFLOW_REF,
      reject_codes: [],
      assertions: [{ id: 'runner-policy', status: 'PASS', detail: 'Runner policy passed.' }],
      status: 'PASS',
      completion_sentinel: 'WIN_PHASE_B_RUNNER_POLICY_COMPLETE',
    };
    writeJson(issuancePath, issuance);
    writeJson(dispatchPath, dispatch);
    writeJson(runnerPath, runner);

    const accepted = validatePhaseBRunBinding({
      issuancePath,
      dispatchPath,
      runnerPolicyReceiptPath: runnerPath,
      outputPath,
    });

    expect(accepted.ok).toBe(true);
    expect(accepted.receipt).toMatchObject({
      status: 'PASS',
      run_id: RUN_ID,
      runner_binding: RUNNER_BINDING,
      completion_sentinel: 'WIN_PHASE_B_JIT_RUN_BINDING_COMPLETE',
    });

    writeJson(dispatchPath, { ...dispatch, run_id: '987654321' });
    const rejected = validatePhaseBRunBinding({
      issuancePath,
      dispatchPath,
      runnerPolicyReceiptPath: runnerPath,
      outputPath: path.join(directory, 'binding-reject.json'),
    });

    expect(rejected.ok).toBe(false);
    expect(rejected.receipt.reject_codes).toContain('WIN_B_BINDING_RUN_ID_MISMATCH');

    const rejectionCases = [
      {
        name: 'workflow-blob',
        issuance,
        dispatch: { ...dispatch, workflow_template_blob: 'f'.repeat(40) },
        runner,
        code: 'WIN_B_BINDING_WORKFLOW_BLOB_MISMATCH',
      },
      {
        name: 'runner-binding',
        issuance,
        dispatch: { ...dispatch, runner_binding: '1'.repeat(32) },
        runner,
        code: 'WIN_B_BINDING_RUNNER_BINDING_MISMATCH',
      },
      {
        name: 'run-attempt',
        issuance,
        dispatch,
        runner: { ...runner, run_attempt: 2 },
        code: 'WIN_B_BINDING_RUN_ATTEMPT_MISMATCH',
      },
      {
        name: 'run-ref',
        issuance,
        dispatch,
        runner: { ...runner, run_ref: `refs/tags/command-eve-phase-b-${'1'.repeat(32)}` },
        code: 'WIN_B_BINDING_RUN_REF_MISMATCH',
      },
      {
        name: 'source-commit',
        issuance,
        dispatch,
        runner: { ...runner, source_commit: 'f'.repeat(40) },
        code: 'WIN_B_BINDING_SOURCE_COMMIT_MISMATCH',
      },
      {
        name: 'runner-id',
        issuance,
        dispatch: { ...dispatch, runner_id: RUNNER_ID + 1 },
        runner,
        code: 'WIN_B_BINDING_RUNNER_ID_MISMATCH',
      },
      {
        name: 'jit-hash',
        issuance,
        dispatch: { ...dispatch, jit_config_sha256: 'f'.repeat(64) },
        runner,
        code: 'WIN_B_BINDING_JIT_CONFIG_HASH_MISMATCH',
      },
      {
        name: 'jit-bytes',
        issuance,
        dispatch: { ...dispatch, jit_config_bytes: JIT_CONFIG_BYTES + 1 },
        runner,
        code: 'WIN_B_BINDING_JIT_CONFIG_BYTES_MISMATCH',
      },
      {
        name: 'derived-runner-name',
        issuance: { ...issuance, runner_name: `command-eve-phase-b-normal-${RUNNER_BINDING.slice(0, 12)}` },
        dispatch: { ...dispatch, runner_name: `command-eve-phase-b-normal-${RUNNER_BINDING.slice(0, 12)}` },
        runner: { ...runner, runner_name: `command-eve-phase-b-normal-${RUNNER_BINDING.slice(0, 12)}` },
        code: 'WIN_B_BINDING_RUNNER_NAME_MISMATCH',
      },
      {
        name: 'runner-pass-shape',
        issuance,
        dispatch,
        runner: { ...runner, reject_codes: ['WIN_B_FORGED'], assertions: [] },
        code: 'WIN_B_BINDING_RUNNER_RECEIPT_INVALID',
      },
    ];

    for (const rejectionCase of rejectionCases) {
      writeJson(issuancePath, rejectionCase.issuance);
      writeJson(dispatchPath, rejectionCase.dispatch);
      writeJson(runnerPath, rejectionCase.runner);
      const outcome = validatePhaseBRunBinding({
        issuancePath,
        dispatchPath,
        runnerPolicyReceiptPath: runnerPath,
        outputPath: path.join(directory, `binding-reject-${rejectionCase.name}.json`),
      });
      expect(outcome.ok, rejectionCase.name).toBe(false);
      expect(outcome.receipt.reject_codes, rejectionCase.name).toContain(rejectionCase.code);
    }

    fs.rmSync(runnerPath);
    expect(() =>
      validatePhaseBRunBinding({
        issuancePath,
        dispatchPath,
        runnerPolicyReceiptPath: runnerPath,
        outputPath: path.join(directory, 'binding-missing.json'),
      })
    ).toThrow();

    fs.writeFileSync(runnerPath, '{not-json');
    expect(() =>
      validatePhaseBRunBinding({
        issuancePath,
        dispatchPath,
        runnerPolicyReceiptPath: runnerPath,
        outputPath: path.join(directory, 'binding-malformed.json'),
      })
    ).toThrow();
  });
});
