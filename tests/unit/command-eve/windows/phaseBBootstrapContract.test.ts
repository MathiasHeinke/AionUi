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

const temporaryDirectories: string[] = [];

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-phase-b-'));
  temporaryDirectories.push(directory);
  return directory;
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

  it('generates JIT config only for the private mirror and never prints the encoded credential', () => {
    const controller = read('.github/scripts/windows/phase-b/generate-jit-config.sh');

    expect(controller).toContain('if [[ "$visibility" != \'private\' ]]');
    expect(controller).toContain('commits/$source_commit');
    expect(controller).toContain('actions/runners/generate-jitconfig');
    expect(controller).toContain('X-GitHub-Api-Version: 2026-03-10');
    expect(controller).toContain('chmod 600 "$jit_temp"');
    expect(controller).toContain('command-eve-windows-phase-b-jit-issuance/v1');
    expect(controller).toContain('credential_delivery: "encoded_jit_config_once"');
    expect(controller).toContain("expected_repository='MathiasHeinke/command-eve-windows-lab'");
    expect(
      controller
        .split('\n')
        .filter((line) => line.trimStart().startsWith('printf') && line.includes('encoded_jit_config'))
    ).toEqual([`printf '%s' "$encoded_jit_config" >"$jit_temp"`]);
    expect(controller).not.toContain('MathiasHeinke/AionUi');
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
    expect(workflowText).toContain('EXPECTED_REPOSITORY: MathiasHeinke/command-eve-windows-lab');
    expect(workflowText).toContain('test "$REPOSITORY_PRIVATE" = "true"');
    expect(workflowText).toContain('test "$SOURCE_COMMIT" = "$TRIGGER_SHA"');
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
    const sourceCommit = 'a'.repeat(40);
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
        schema_version: 'command-eve-windows-phase-b-runner-policy/v1',
        repository: { full_name: 'MathiasHeinke/command-eve-windows-lab', visibility: 'private' },
        dispatch: {
          event_name: 'workflow_dispatch',
          requested_commit: sourceCommit,
          trigger_commit: sourceCommit,
          pull_request_from_fork: false,
          permissions: { contents: 'read', id_token: 'none' },
        },
        runner: {
          mode: 'jit',
          max_jobs: 1,
          labels: ['self-hosted', 'Windows', 'X64', 'command-eve-phase-b', 'phase-b-lowmem'],
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
      expectedRepository: 'MathiasHeinke/command-eve-windows-lab',
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
      expectedRepository: 'MathiasHeinke/command-eve-windows-lab',
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
});
