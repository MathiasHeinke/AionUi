/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMMAND_EVE_BUNDLED_HERMES_WHEEL_SHA256,
  ensureCommandEveRuntimeBootstrap,
  prepareCommandEveRuntimeProcessEnv,
  resolveBundledPythonCandidate,
  resolveCommandEveRuntimeBootstrapPaths,
  terminateRuntimeBootstrapProcessTree,
  windowsRuntimeTaskkillArgs,
  type RuntimeBootstrapRunner,
} from '@/process/commandEve/runtimeBootstrapCore';
import { shouldRestartWindowsBackendAfterRuntimeBootstrap } from '@/process/commandEve/windows/runtimeActivationCore';
import {
  parseResolvedPythonPackages,
  readBundledPythonProvenance,
  sha256FileIfPresent,
} from '@/process/commandEve/windows/runtimeProvenanceCore';
import {
  COMMAND_EVE_ARTIFACT_PYTHON_PACKAGES,
  COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_RECEIPT,
  COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_VERSION,
  COMMAND_EVE_ARTIFACT_PYTHON_SITE_SUBDIR,
} from '@/process/commandEve/presentationPythonRuntimeCore';

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-windows-runtime-'));
  roots.push(root);
  return path.join(root, 'Pilot User Data');
}

function writeFile(filePath: string, content = 'fixture'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeWindowsVenv(venvPath: string, pythonContent: string): void {
  writeFile(path.join(venvPath, 'Scripts', 'python.exe'), pythonContent);
  writeFile(path.join(venvPath, 'pyvenv.cfg'), 'version = 3.12.13\n');
}

function writeArtifactPythonSiteFixture(resourcesPath: string): string {
  const sitePath = path.join(resourcesPath, 'python', COMMAND_EVE_ARTIFACT_PYTHON_SITE_SUBDIR);
  // The hardened site verifier (Pro-verdict Gate 2) requires the full receipt
  // contract: tree phase, tree root hash over the enumerated site files, and
  // per-package wheel/metadata hashes + tags. The fixture site contains only
  // the receipt, so the tree is empty and its root hash is sha256('[]').
  const emptyTreeRoot = crypto.createHash('sha256').update('[]').digest('hex');
  writeFile(
    path.join(sitePath, COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_RECEIPT),
    JSON.stringify({
      version: COMMAND_EVE_ARTIFACT_PYTHON_RUNTIME_VERSION,
      runtime_key: 'win32-x64',
      network_install_allowed: false,
      tree_phase: 'signed',
      tree_root_sha256: emptyTreeRoot,
      tree_files: [],
      spread_files: [],
      packages: COMMAND_EVE_ARTIFACT_PYTHON_PACKAGES.map((entry) => ({
        name: entry.name,
        version: entry.version,
        import_name: entry.importName,
        wheel: entry.filename,
        wheel_sha256: entry.sha256,
        metadata_sha256: 'a'.repeat(64),
        wheel_tags: ['py3-none-any'],
      })),
    })
  );
  return sitePath;
}

function readWheelEntry(wheelPath: string, entryName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(wheelPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error(`Could not open wheel: ${wheelPath}`));
        return;
      }

      let found = false;
      const fail = (error: Error): void => {
        zipFile.close();
        reject(error);
      };

      zipFile.on('error', fail);
      zipFile.on('end', () => {
        if (!found) fail(new Error(`Wheel entry not found: ${entryName}`));
      });
      zipFile.on('entry', (entry) => {
        if (entry.fileName !== entryName) {
          zipFile.readEntry();
          return;
        }

        found = true;
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(streamError ?? new Error(`Could not read wheel entry: ${entryName}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', fail);
          stream.on('end', () => {
            zipFile.close();
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
        });
      });
      zipFile.readEntry();
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Command EVE Windows runtime paths', () => {
  it('resolves the bundled interpreter and direct Hermes console executable without Bash', () => {
    const root = makeRoot();
    const resourcesPath = path.join(root, 'resources');
    const paths = resolveCommandEveRuntimeBootstrapPaths(root, null, 'win32');

    expect(resolveBundledPythonCandidate({}, resourcesPath, 'win32')).toBe(
      path.join(resourcesPath, 'python', 'python.exe')
    );
    expect(paths.platform).toBe('win32');
    expect(paths.hermesShim).toBe(path.join(paths.hermesVenv, 'Scripts', 'hermes.exe'));

    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\System32' };
    prepareCommandEveRuntimeProcessEnv(root, env, 'win32');
    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.join(paths.hermesVenv, 'Scripts'));
    expect(fs.existsSync(path.join(paths.hermesRoot, 'hermes'))).toBe(false);
    expect(fs.existsSync(paths.hermesWrapper)).toBe(false);
  });

  it('parses only pinned package rows and reads hash-validated provenance', () => {
    const root = makeRoot();
    const resourcesPath = path.join(root, 'resources');
    const manifestPath = path.join(resourcesPath, 'python', 'command-eve-python-manifest.json');
    const wheelPath = path.join(resourcesPath, 'bundled-hermes', 'hermes.whl');
    writeFile(
      manifestPath,
      JSON.stringify({
        schema_version: 'command-eve-bundled-python/v1',
        platform: 'win32',
        arch: 'x64',
        triple: 'x86_64-pc-windows-msvc',
        python_version: '3.12.13',
        release_tag: '20260610',
        archive_name: 'python.tar.gz',
        archive_sha256: 'a'.repeat(64),
        source_url: 'https://example.invalid/python.tar.gz',
      })
    );
    writeFile(wheelPath, 'wheel-fixture');

    expect(readBundledPythonProvenance(resourcesPath)).toMatchObject({ platform: 'win32', arch: 'x64' });
    expect(sha256FileIfPresent(wheelPath)).toMatch(/^[0-9a-f]{64}$/);
    expect(parseResolvedPythonPackages('pip==25.0\r\ninvalid row\nhermes-agent @ file:///tmp/wheel\n')).toEqual([
      'hermes-agent @ file:///tmp/wheel',
      'pip==25.0',
    ]);
  });

  it('pins the committed Hermes wheel bytes', () => {
    const wheelPath = path.resolve('resources', 'bundled-hermes', 'hermes_agent-0.20.0-py3-none-any.whl');

    expect(sha256FileIfPresent(wheelPath)).toBe(COMMAND_EVE_BUNDLED_HERMES_WHEEL_SHA256);
  });

  it('pins the model-hidden ACP transport contract inside the committed Hermes wheel', async () => {
    const wheelPath = path.resolve('resources', 'bundled-hermes', 'hermes_agent-0.20.0-py3-none-any.whl');
    const [delegateTool, runAgent, auth] = await Promise.all([
      readWheelEntry(wheelPath, 'tools/delegate_tool.py'),
      readWheelEntry(wheelPath, 'run_agent.py'),
      readWheelEntry(wheelPath, 'hermes_cli/auth.py'),
    ]);
    const schemaStart = delegateTool.indexOf('DELEGATE_TASK_SCHEMA =');
    const schemaEnd = delegateTool.indexOf('# --- Registry ---', schemaStart);
    const modelSchema = delegateTool.slice(schemaStart, schemaEnd);

    expect(schemaStart).toBeGreaterThanOrEqual(0);
    expect(schemaEnd).toBeGreaterThan(schemaStart);
    expect(modelSchema).not.toContain('"acp_command"');
    expect(modelSchema).not.toContain('"acp_args"');
    expect(delegateTool).toContain('_MODEL_HIDDEN_TASK_FIELDS = {"acp_command", "acp_args"}');
    expect(delegateTool).toContain('override_acp_command=creds.get("command")');
    expect(delegateTool).toContain('override_acp_args=creds.get("args")');
    expect(runAgent).not.toContain('function_args.get("acp_command")');
    expect(runAgent).not.toContain('function_args.get("acp_args")');
    expect(auth).toContain('os.getenv("HERMES_COPILOT_ACP_COMMAND"');
    expect(auth).toContain('os.getenv("HERMES_COPILOT_ACP_ARGS"');
    expect(auth).toContain('args = shlex.split(raw_args)');
  });

  it('keeps ACP approvals under Command EVE authority without a wheel-level yolo bypass', async () => {
    const wheelPath = path.resolve('resources', 'bundled-hermes', 'hermes_agent-0.20.0-py3-none-any.whl');
    const [server, approval] = await Promise.all([
      readWheelEntry(wheelPath, 'acp_adapter/server.py'),
      readWheelEntry(wheelPath, 'tools/approval.py'),
    ]);

    expect(server).not.toContain('def _sync_terminal_approval_mode(self, state: SessionState)');
    expect(server).not.toContain('enable_session_yolo(state.session_id)');
    expect(server).not.toContain('approvals.mode = "off"');

    const guardStart = approval.indexOf('def check_all_command_guards(');
    const guardEnd = approval.indexOf('\ndef ', guardStart + 1);
    const commandGuards = approval.slice(guardStart, guardEnd);
    expect(guardStart).toBeGreaterThanOrEqual(0);
    expect(commandGuards.indexOf('detect_hardline_command(command)')).toBeGreaterThanOrEqual(0);
    expect(commandGuards.indexOf('_check_sudo_stdin_guard(command)')).toBeGreaterThan(
      commandGuards.indexOf('detect_hardline_command(command)')
    );
    expect(commandGuards.indexOf('is_current_session_yolo_enabled()')).toBeGreaterThan(
      commandGuards.indexOf('_check_sudo_stdin_guard(command)')
    );
  });
});

describe('Command EVE Windows process cleanup', () => {
  it('kills the complete Windows process tree on timeout', () => {
    const kill = vi.fn((_signal?: string | number) => true);
    const taskkill = vi.fn(() => ({ status: 0 }));

    const strategy = terminateRuntimeBootstrapProcessTree({ pid: 4242, kill }, 'win32', taskkill);

    expect(strategy).toBe('taskkill');
    expect(taskkill).toHaveBeenCalledWith('taskkill', ['/PID', '4242', '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10_000,
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it('falls back to a direct signal and rejects unsafe process ids', () => {
    const kill = vi.fn((_signal?: string | number) => true);
    const taskkill = vi.fn(() => ({ status: 1 }));

    expect(terminateRuntimeBootstrapProcessTree({ pid: 4242, kill }, 'win32', taskkill)).toBe('signal');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(() => windowsRuntimeTaskkillArgs(0)).toThrow('positive integer');
  });
});

describe('Command EVE Windows cloud turn-holder profile', () => {
  it('restarts only a first-ready deferred Windows desktop runtime', () => {
    const firstReadyDesktop = {
      platform: 'win32' as const,
      surface: 'desktop' as const,
      runtimeProfile: 'cloud_turn_holder_only',
      receiptStatus: 'ready',
      hermesReadyBeforeBootstrap: false,
      hermesReadyAfterBootstrap: true,
    };

    expect(shouldRestartWindowsBackendAfterRuntimeBootstrap(firstReadyDesktop)).toBe(true);
    expect(shouldRestartWindowsBackendAfterRuntimeBootstrap({ ...firstReadyDesktop, surface: 'webui' })).toBe(false);
    expect(shouldRestartWindowsBackendAfterRuntimeBootstrap({ ...firstReadyDesktop, platform: 'darwin' })).toBe(false);
    expect(shouldRestartWindowsBackendAfterRuntimeBootstrap({ ...firstReadyDesktop, receiptStatus: 'blocked' })).toBe(
      false
    );
    expect(
      shouldRestartWindowsBackendAfterRuntimeBootstrap({
        ...firstReadyDesktop,
        hermesReadyBeforeBootstrap: true,
      })
    ).toBe(false);
    expect(
      shouldRestartWindowsBackendAfterRuntimeBootstrap({
        ...firstReadyDesktop,
        hermesReadyAfterBootstrap: false,
      })
    ).toBe(false);
  });

  it('installs Hermes with bundled Python and never starts the local-model lane', async () => {
    const root = makeRoot();
    const resourcesPath = path.join(root, 'packaged resources');
    const bundledPython = path.join(resourcesPath, 'python', 'python.exe');
    writeFile(bundledPython, 'windows-python-fixture');
    writeFile(
      path.join(resourcesPath, 'python', 'command-eve-python-manifest.json'),
      JSON.stringify({
        schema_version: 'command-eve-bundled-python/v1',
        platform: 'win32',
        arch: 'x64',
        triple: 'x86_64-pc-windows-msvc',
        python_version: '3.12.13',
        release_tag: '20260610',
        archive_name: 'python.tar.gz',
        archive_sha256: 'b'.repeat(64),
        source_url: 'https://example.invalid/python.tar.gz',
      })
    );
    const bundledHermesWheel = path.join(resourcesPath, 'bundled-hermes', 'hermes_agent-0.20.0-py3-none-any.whl');
    writeFile(bundledHermesWheel, 'hermes-wheel-fixture');
    writeArtifactPythonSiteFixture(resourcesPath);
    const expectedHermesWheelSha256 = sha256FileIfPresent(bundledHermesWheel)!;
    const commands: string[] = [];
    const paths = resolveCommandEveRuntimeBootstrapPaths(root, null, 'win32');

    const runner: RuntimeBootstrapRunner = async (command, args) => {
      commands.push([command, ...args].join(' '));
      if (command === bundledPython && args[0] === '--version') {
        return { command, args, ok: true, status: 0, stdout: 'Python 3.12.13\n' };
      }
      if (command === bundledPython && args[0] === '-m' && args[1] === 'venv') {
        writeWindowsVenv(args[2], 'venv-python-fixture');
        return { command, args, ok: true, status: 0 };
      }
      if (command.endsWith(path.join('Scripts', 'python.exe')) && args.join(' ') === '-m pip freeze --all') {
        return {
          command,
          args,
          ok: true,
          status: 0,
          stdout: 'hermes-agent==0.20.0\npip==25.1\n',
        };
      }
      if (
        command.endsWith(path.join('Scripts', 'python.exe')) &&
        args[0] === '-c' &&
        args[1]?.includes("version('hermes-agent')")
      ) {
        return { command, args, ok: true, status: 0, stdout: '0.20.0\n' };
      }
      if (
        command.endsWith(path.join('Scripts', 'python.exe')) &&
        args.join(' ') === '-c import site; print(site.getsitepackages()[0])'
      ) {
        const sitePackages = path.join(paths.hermesVenv, 'Lib', 'site-packages');
        writeFile(path.join(sitePackages, '.fixture'));
        return { command, args, ok: true, status: 0, stdout: `${sitePackages}\n` };
      }
      if (
        command.endsWith(path.join('Scripts', 'python.exe')) &&
        // The hardened probe runs `python -I -P -S -c <source>`; match -c
        // anywhere and inspect the source argument.
        args.includes('-c') &&
        args[args.indexOf('-c') + 1]?.includes('PRESENTATION_PYTHON_READY')
      ) {
        return { command, args, ok: true, status: 0, stdout: 'PRESENTATION_PYTHON_READY\n' };
      }
      if (command.endsWith(path.join('Scripts', 'python.exe')) && args.includes('pip')) {
        const installTarget = args.at(-1) || '';
        if (/hermes[_-]agent/i.test(installTarget)) {
          writeFile(path.join(path.dirname(command), 'hermes.exe'), 'hermes-console-fixture');
        }
        return { command, args, ok: true, status: 0 };
      }
      if (command.endsWith(path.join('Scripts', 'python.exe')) && args.join(' ') === '-c import ddgs') {
        return { command, args, ok: true, status: 0 };
      }
      return { command, args, ok: false, status: 1, stderr: `Unexpected command: ${command} ${args.join(' ')}` };
    };

    const receipt = await ensureCommandEveRuntimeBootstrap({
      userDataPath: root,
      resourcesPath,
      platform: 'win32',
      runtimeProfile: 'cloud_turn_holder_only',
      runner,
      expectedHermesWheelSha256,
      totalMemoryBytes: 32 * 1024 ** 3,
      statfs: () => ({ bavail: 30, bsize: 1024 ** 3 }),
    });
    expect(receipt.status).toBe('ready');
    expect(receipt.runtime_profile).toBe('cloud_turn_holder_only');
    expect(receipt.runtime_provenance.python).toMatchObject({
      source: 'bundled',
      version: 'Python 3.12.13',
      archive: { platform: 'win32', archive_sha256: 'b'.repeat(64) },
    });
    expect(receipt.runtime_provenance.hermes).toMatchObject({
      install_source: 'bundled_wheel',
      wheel_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      dependency_resolution: 'pypi_tls_on_first_boot',
      package_snapshot_status: 'captured',
      resolved_packages: ['hermes-agent==0.20.0', 'pip==25.1'],
    });
    expect(receipt.stages.find((stage) => stage.id === 'python')?.status).toBe('pass');
    expect(receipt.stages.find((stage) => stage.id === 'hermes')?.status).toBe('pass');
    expect(receipt.stages.find((stage) => stage.id === 'ollama')).toMatchObject({
      status: 'skip',
      code: 'CLOUD_TURN_HOLDER_ONLY',
    });
    expect(receipt.stages.find((stage) => stage.id === 'model')).toMatchObject({
      status: 'skip',
      code: 'CLOUD_TURN_HOLDER_ONLY',
    });
    expect(commands.some((command) => /bash|ollama|brew|where\.exe/i.test(command))).toBe(false);
    expect(fs.readFileSync(paths.hermesShim, 'utf8')).toBe('hermes-console-fixture');
    expect(fs.existsSync(paths.hermesWrapper)).toBe(false);

    commands.length = 0;
    const secondReceipt = await ensureCommandEveRuntimeBootstrap({
      userDataPath: root,
      resourcesPath,
      platform: 'win32',
      runtimeProfile: 'cloud_turn_holder_only',
      runner,
      expectedHermesWheelSha256,
      totalMemoryBytes: 32 * 1024 ** 3,
      statfs: () => ({ bavail: 30, bsize: 1024 ** 3 }),
    });
    expect(secondReceipt.status).toBe('ready');
    expect(secondReceipt.runtime_provenance).toEqual(receipt.runtime_provenance);
    expect(commands.some((command) => command.includes('-m pip install'))).toBe(false);

    const env: NodeJS.ProcessEnv = { PATH: 'C:\\Windows\\System32' };
    prepareCommandEveRuntimeProcessEnv(root, env, 'win32');
    expect(fs.readFileSync(paths.hermesShim, 'utf8')).toBe('hermes-console-fixture');
  });

  it('classifies an offline first boot and repairs the same profile without deleting user data', async () => {
    const root = makeRoot();
    const resourcesPath = path.join(root, 'resources');
    const bundledPython = path.join(resourcesPath, 'python', 'python.exe');
    const conversationFixture = path.join(root, 'conversations', 'customer-work.json');
    writeFile(bundledPython, 'windows-python-fixture');
    writeFile(conversationFixture, '{"keep":true}');
    const bundledHermesWheel = path.join(resourcesPath, 'bundled-hermes', 'hermes_agent-0.20.0-py3-none-any.whl');
    writeFile(bundledHermesWheel, 'hermes-wheel-fixture');
    writeArtifactPythonSiteFixture(resourcesPath);
    const expectedHermesWheelSha256 = sha256FileIfPresent(bundledHermesWheel)!;
    const paths = resolveCommandEveRuntimeBootstrapPaths(root, null, 'win32');

    const offlineRunner: RuntimeBootstrapRunner = async (command, args) => {
      if (command === bundledPython && args[0] === '--version') {
        return { command, args, ok: true, status: 0, stdout: 'Python 3.12.13\n' };
      }
      if (command === bundledPython && args[0] === '-m' && args[1] === 'venv') {
        writeWindowsVenv(args[2], 'partial-venv-python');
        return { command, args, ok: true, status: 0 };
      }
      return { command, args, ok: false, status: 1, stderr: 'network unavailable' };
    };
    const first = await ensureCommandEveRuntimeBootstrap({
      userDataPath: root,
      resourcesPath,
      platform: 'win32',
      runtimeProfile: 'cloud_turn_holder_only',
      runner: offlineRunner,
      expectedHermesWheelSha256,
      totalMemoryBytes: 16 * 1024 ** 3,
      statfs: () => ({ bavail: 30, bsize: 1024 ** 3 }),
    });
    expect(first.status).toBe('failed');
    expect(first.stages.find((stage) => stage.id === 'hermes')).toMatchObject({
      status: 'failed',
      code: 'HERMES_INSTALL_FAILED',
    });
    expect(fs.readFileSync(conversationFixture, 'utf8')).toBe('{"keep":true}');

    const onlineRunner: RuntimeBootstrapRunner = async (command, args) => {
      if (command === bundledPython && args[0] === '--version') {
        return { command, args, ok: true, status: 0, stdout: 'Python 3.12.13\n' };
      }
      if (command.endsWith(path.join('Scripts', 'python.exe')) && args.join(' ') === '-m pip freeze --all') {
        return { command, args, ok: true, status: 0, stdout: 'hermes-agent==0.20.0\n' };
      }
      if (command.endsWith(path.join('Scripts', 'python.exe')) && args.includes('pip')) {
        if (/hermes[_-]agent/i.test(args.at(-1) || '')) {
          writeFile(path.join(path.dirname(command), 'hermes.exe'), 'repaired-hermes');
        }
        return { command, args, ok: true, status: 0 };
      }
      if (command.endsWith(path.join('Scripts', 'python.exe')) && args.join(' ') === '-c import ddgs') {
        return { command, args, ok: true, status: 0 };
      }
      if (
        command.endsWith(path.join('Scripts', 'python.exe')) &&
        args.join(' ') === '-c import site; print(site.getsitepackages()[0])'
      ) {
        const sitePackages = path.join(paths.hermesVenv, 'Lib', 'site-packages');
        writeFile(path.join(sitePackages, '.fixture'));
        return { command, args, ok: true, status: 0, stdout: `${sitePackages}\n` };
      }
      if (
        command.endsWith(path.join('Scripts', 'python.exe')) &&
        // The hardened probe runs `python -I -P -S -c <source>`; match -c
        // anywhere and inspect the source argument.
        args.includes('-c') &&
        args[args.indexOf('-c') + 1]?.includes('PRESENTATION_PYTHON_READY')
      ) {
        return { command, args, ok: true, status: 0, stdout: 'PRESENTATION_PYTHON_READY\n' };
      }
      return { command, args, ok: false, status: 1, stderr: 'unexpected command' };
    };
    const repaired = await ensureCommandEveRuntimeBootstrap({
      userDataPath: root,
      resourcesPath,
      platform: 'win32',
      runtimeProfile: 'cloud_turn_holder_only',
      runner: onlineRunner,
      expectedHermesWheelSha256,
      totalMemoryBytes: 16 * 1024 ** 3,
      statfs: () => ({ bavail: 30, bsize: 1024 ** 3 }),
    });
    expect(repaired.status).toBe('ready');
    expect(repaired.runtime_provenance.hermes?.package_snapshot_status).toBe('captured');
    expect(fs.readFileSync(conversationFixture, 'utf8')).toBe('{"keep":true}');
  });

  it('fails before pip when bundled Hermes bytes do not match the pin', async () => {
    const root = makeRoot();
    const resourcesPath = path.join(root, 'resources');
    const bundledPython = path.join(resourcesPath, 'python', 'python.exe');
    writeFile(bundledPython, 'windows-python-fixture');
    writeFile(
      path.join(resourcesPath, 'bundled-hermes', 'hermes_agent-0.20.0-py3-none-any.whl'),
      'tampered-hermes-wheel-fixture'
    );
    const commands: string[] = [];
    const runner: RuntimeBootstrapRunner = async (command, args) => {
      commands.push([command, ...args].join(' '));
      if (command === bundledPython && args[0] === '--version') {
        return { command, args, ok: true, status: 0, stdout: 'Python 3.12.13\n' };
      }
      if (command === bundledPython && args[0] === '-m' && args[1] === 'venv') {
        writeWindowsVenv(args[2], 'venv-python-fixture');
        return { command, args, ok: true, status: 0 };
      }
      return { command, args, ok: false, status: 1, stderr: 'unexpected command' };
    };

    const receipt = await ensureCommandEveRuntimeBootstrap({
      userDataPath: root,
      resourcesPath,
      platform: 'win32',
      runtimeProfile: 'cloud_turn_holder_only',
      runner,
      expectedHermesWheelSha256: '0'.repeat(64),
      totalMemoryBytes: 16 * 1024 ** 3,
      statfs: () => ({ bavail: 30, bsize: 1024 ** 3 }),
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.runtime_provenance.hermes).toMatchObject({
      wheel_expected_sha256: '0'.repeat(64),
      wheel_sha256_verified: false,
    });
    expect(receipt.stages.find((stage) => stage.id === 'hermes')).toMatchObject({
      status: 'failed',
      code: 'HERMES_WHEEL_HASH_MISMATCH',
    });
    expect(commands.some((command) => command.includes('-m pip install'))).toBe(false);
  });
});
