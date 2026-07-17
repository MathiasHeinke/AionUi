/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_DELEGATE_TIMEOUT_SECONDS,
  HERMES_COPILOT_ACP_ARGS_ENV,
  HERMES_COPILOT_ACP_COMMAND_ENV,
  applyLauncherWiring,
  clearHermesDelegateTransportEnv,
  computeLauncherStatePaths,
  renderLauncherStatus,
  resolveBundledClaudeAcpTransport,
  resolveBundledLauncherPath,
  serializeHermesAcpArgs,
  syncEveWorkerLauncherFiles,
  WINDOWS_LAUNCHER_INTERPRETER,
  wrapClaudeDelegateWithLauncher,
} from '../../../packages/desktop/src/process/commandEve/eveWorkerLauncherCore';
import { __resetEveAgentTaskRegistryForTest } from '../../../packages/desktop/src/process/commandEve/eveAgentTaskRegistry';
import {
  CLAUDE_ACP_ADAPTER_PACKAGE,
  CLAUDE_ACP_ADAPTER_VERSION,
  CLAUDE_SEAT_BILLING_LANE,
  CLAUDE_SEAT_FALLBACK_POLICY,
  CLAUDE_SEAT_RUNTIME_ROUTE,
  type ResolvedClaudeDelegate,
} from '../../../packages/desktop/src/common/config/eveWorkerAssignmentCore';

const DELEGATE: ResolvedClaudeDelegate = {
  agent_id: 'growth-lead',
  label: 'Claude',
  acpCommand: 'bunx',
  acpArgs: [CLAUDE_ACP_ADAPTER_PACKAGE],
  provider: 'copilot-acp',
  billingLane: CLAUDE_SEAT_BILLING_LANE,
  runtimeRoute: CLAUDE_SEAT_RUNTIME_ROUTE,
  fallbackPolicy: CLAUDE_SEAT_FALLBACK_POLICY,
};

describe('eveWorkerLauncherCore (SG-1 A3/A4)', () => {
  describe('trusted Hermes ACP transport env', () => {
    it('quotes every argv token for Python shlex without putting the token value in env', () => {
      expect(serializeHermesAcpArgs(['plain', 'path with spaces', "O'Brien", 'C:\\Program Files\\EVE'])).toBe(
        `'plain' 'path with spaces' 'O'"'"'Brien' 'C:\\Program Files\\EVE'`
      );
    });

    it('binds only the launcher-wrapped transport and revokes stale env on disable', () => {
      const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-transport-'));
      const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-launcher-'));
      fs.writeFileSync(path.join(launcherDir, 'eve-acp-launcher.sh'), '#!/bin/sh\n');
      const env = {
        COMMAND_EVE_LAUNCHER_DIR: launcherDir,
        [HERMES_COPILOT_ACP_COMMAND_ENV]: 'hostile-old-command',
        [HERMES_COPILOT_ACP_ARGS_ENV]: 'hostile-old-args',
      } as NodeJS.ProcessEnv;
      const assignments = { 'growth-lead': { agent_id: 'growth-lead', kind: 'claude' } } as never;
      const statuses = { 'growth-lead': 'active' } as never;

      const wrapped = applyLauncherWiring(DELEGATE, assignments, statuses, {
        dataPath,
        seatId: 'seat-1',
        env,
        platform: 'darwin',
      });
      expect(wrapped?.acpCommand).toBe('/bin/sh');
      expect(wrapped).toMatchObject({
        billingLane: CLAUDE_SEAT_BILLING_LANE,
        runtimeRoute: CLAUDE_SEAT_RUNTIME_ROUTE,
        fallbackPolicy: CLAUDE_SEAT_FALLBACK_POLICY,
      });
      expect(env[HERMES_COPILOT_ACP_COMMAND_ENV]).toBe('/bin/sh');
      expect(env[HERMES_COPILOT_ACP_ARGS_ENV]).toContain("'--role'");
      expect(env[HERMES_COPILOT_ACP_ARGS_ENV]).not.toContain('hostile-old');

      clearHermesDelegateTransportEnv(env);
      expect(env[HERMES_COPILOT_ACP_COMMAND_ENV]).toBeUndefined();
      expect(env[HERMES_COPILOT_ACP_ARGS_ENV]).toBeUndefined();
      expect(applyLauncherWiring(null, assignments, statuses, { dataPath, seatId: 'seat-1', env })).toBeNull();
      expect(env[HERMES_COPILOT_ACP_COMMAND_ENV]).toBeUndefined();
      expect(env[HERMES_COPILOT_ACP_ARGS_ENV]).toBeUndefined();

      fs.rmSync(dataPath, { recursive: true, force: true });
      fs.rmSync(launcherDir, { recursive: true, force: true });
    });

    it.each([
      ['app-metered billing', { billingLane: 'app_metered' }],
      ['EVE Inference/OpenRouter execution', { runtimeRoute: 'eve_inference_openrouter' }],
      ['cloud fallback', { fallbackPolicy: 'eve_inference' }],
    ])('revokes transport and refuses a Claude-seat delegate carrying %s', (_case, override) => {
      const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-transport-reject-'));
      const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-launcher-reject-'));
      fs.writeFileSync(path.join(launcherDir, 'eve-acp-launcher.sh'), '#!/bin/sh\n');
      const env = {
        COMMAND_EVE_LAUNCHER_DIR: launcherDir,
        [HERMES_COPILOT_ACP_COMMAND_ENV]: 'hostile-old-command',
        [HERMES_COPILOT_ACP_ARGS_ENV]: 'hostile-old-args',
      } as NodeJS.ProcessEnv;

      const result = applyLauncherWiring(
        { ...DELEGATE, ...override } as unknown as ResolvedClaudeDelegate,
        { 'growth-lead': { agent_id: 'growth-lead', kind: 'claude' } } as never,
        { 'growth-lead': 'active' } as never,
        { dataPath, seatId: 'seat-1', env, platform: 'darwin' }
      );

      expect(result).toBeNull();
      expect(env[HERMES_COPILOT_ACP_COMMAND_ENV]).toBeUndefined();
      expect(env[HERMES_COPILOT_ACP_ARGS_ENV]).toBeUndefined();

      fs.rmSync(dataPath, { recursive: true, force: true });
      fs.rmSync(launcherDir, { recursive: true, force: true });
    });
  });

  describe('wrapClaudeDelegateWithLauncher (A4 — token never in acp_args)', () => {
    const cfg = {
      launcherPath: '/abs/resources/eve-acp-launcher/eve-acp-launcher.sh',
      statusFile: '/abs/state/seat-1/growth-lead.status',
      tokenFile: '/abs/state/seat-1/growth-lead.token',
    };

    it('runs the launcher via /bin/sh (no exec-bit dependency) and wraps the adapter after `--`', () => {
      const wrapped = wrapClaudeDelegateWithLauncher(DELEGATE, cfg);
      expect(wrapped.acpCommand).toBe('/bin/sh');
      expect(wrapped.acpArgs).toEqual([
        cfg.launcherPath,
        '--role',
        'growth-lead',
        '--status-file',
        cfg.statusFile,
        '--token-file',
        cfg.tokenFile,
        '--',
        'bunx',
        CLAUDE_ACP_ADAPTER_PACKAGE,
      ]);
    });

    it('carries the token FILE PATH but NEVER a token value in acp_args (A4)', () => {
      const wrapped = wrapClaudeDelegateWithLauncher(DELEGATE, cfg);
      // The token file path is present…
      expect(wrapped.acpArgs).toContain(cfg.tokenFile);
      // …but --token-file is a flag+path pair; there is no bare token payload.
      const idx = wrapped.acpArgs.indexOf('--token-file');
      expect(wrapped.acpArgs[idx + 1]).toBe(cfg.tokenFile);
      // Serialized args (what SOUL shows) must not contain a hex-token-looking blob.
      expect(JSON.stringify(wrapped.acpArgs)).not.toMatch(/[0-9a-f]{40,}/);
    });

    it('uses the Windows PowerShell boundary with read-only mode + a bounded two-hour ceiling', () => {
      const windowsCfg = {
        launcherPath: 'C:\\Program Files\\Command EVE\\resources\\eve-acp-launcher\\eve-acp-launcher.ps1',
        statusFile: 'C:\\Users\\pilot\\state\\growth-lead.status',
        tokenFile: 'C:\\Users\\pilot\\state\\growth-lead.token',
        platform: 'win32' as const,
      };
      const wrapped = wrapClaudeDelegateWithLauncher(DELEGATE, windowsCfg);
      expect(wrapped.acpCommand).toBe(WINDOWS_LAUNCHER_INTERPRETER);
      expect(wrapped.acpArgs).toEqual([
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        windowsCfg.launcherPath,
        '--role',
        'growth-lead',
        '--status-file',
        windowsCfg.statusFile,
        '--token-file',
        windowsCfg.tokenFile,
        '--timeout-seconds',
        String(COMMAND_EVE_DELEGATE_TIMEOUT_SECONDS),
        '--read-only',
        '--',
        'bunx',
        CLAUDE_ACP_ADAPTER_PACKAGE,
      ]);
      expect(wrapped.acpArgs).not.toContain('/bin/sh');
    });

    it('clamps a hostile Windows timeout below the one-minute safety floor', () => {
      const wrapped = wrapClaudeDelegateWithLauncher(DELEGATE, {
        ...cfg,
        launcherPath: 'C:\\eve\\eve-acp-launcher.ps1',
        platform: 'win32',
        timeoutSeconds: 1,
      });
      const timeoutIndex = wrapped.acpArgs.indexOf('--timeout-seconds');
      expect(wrapped.acpArgs[timeoutIndex + 1]).toBe('60');
    });

    it('fails OPEN (returns the delegate unchanged) when the launcher path is missing/relative', () => {
      expect(wrapClaudeDelegateWithLauncher(DELEGATE, { ...cfg, launcherPath: '' })).toEqual(DELEGATE);
      expect(wrapClaudeDelegateWithLauncher(DELEGATE, { ...cfg, launcherPath: 'relative/x.sh' })).toEqual(DELEGATE);
    });
  });

  describe('renderLauncherStatus (bare-string invariant)', () => {
    it('maps only the exact vocabulary; everything else is active (fail-open availability)', () => {
      expect(renderLauncherStatus('paused')).toBe('paused');
      expect(renderLauncherStatus('off')).toBe('off');
      expect(renderLauncherStatus('active')).toBe('active');
      expect(renderLauncherStatus(undefined)).toBe('active');
      expect(renderLauncherStatus('PAUSED')).toBe('active'); // not the exact word
      expect(renderLauncherStatus({ status: 'paused' })).toBe('active'); // never a JSON blob
    });
  });

  describe('computeLauncherStatePaths (outside hermesHome)', () => {
    it('roots state under <dataPath>/eve-acp-launcher/<seat>/, not under seats/<seat>/hermes', () => {
      const p = computeLauncherStatePaths('/data', 'seat-1', 'growth-lead');
      const stateRoot = path.join('/data', 'eve-acp-launcher', 'seat-1');
      expect(p.statusFile).toBe(path.join(stateRoot, 'growth-lead.status'));
      expect(p.tokenFile).toBe(path.join(stateRoot, 'growth-lead.token'));
      expect(p.statusFile).not.toContain(`${path.sep}hermes${path.sep}`);
    });
    it('sanitizes a hostile seat id into a safe path fragment', () => {
      const p = computeLauncherStatePaths('/data', '../evil/../../etc', 'growth-lead');
      expect(p.dir).not.toContain('..');
    });
  });

  describe('resolveBundledLauncherPath', () => {
    it('honours the explicit env dir first when the script exists there', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-launcher-'));
      fs.writeFileSync(path.join(dir, 'eve-acp-launcher.sh'), '#!/bin/sh\n');
      // Even with a bogus resourcesPath, the explicit env dir wins (precedence 1).
      const resolved = resolveBundledLauncherPath(
        { COMMAND_EVE_LAUNCHER_DIR: dir } as NodeJS.ProcessEnv,
        '/bogus/resources'
      );
      expect(resolved).toBe(path.join(dir, 'eve-acp-launcher.sh'));
      expect(path.isAbsolute(resolved)).toBe(true);
      fs.rmSync(dir, { recursive: true, force: true });
    });
    it('selects the committed PowerShell launcher on Windows', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-launcher-win-'));
      fs.writeFileSync(path.join(dir, 'eve-acp-launcher.ps1'), '# windows launcher\n');
      const resolved = resolveBundledLauncherPath(
        { COMMAND_EVE_LAUNCHER_DIR: dir } as NodeJS.ProcessEnv,
        '/bogus/resources',
        'win32'
      );
      expect(resolved).toBe(path.join(dir, 'eve-acp-launcher.ps1'));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    it('falls back to the committed dev snapshot (resources/eve-acp-launcher) when no env/resourcesPath resolves', () => {
      // The launcher IS committed in this repo, so the cwd dev-snapshot fallback
      // resolves it — this is the real dev-box behavior. It must be absolute + exist.
      const resolved = resolveBundledLauncherPath(
        { COMMAND_EVE_LAUNCHER_DIR: '/no/such/dir/xyz' } as NodeJS.ProcessEnv,
        '/also/missing'
      );
      expect(resolved.endsWith(path.join('resources', 'eve-acp-launcher', 'eve-acp-launcher.sh'))).toBe(true);
      expect(path.isAbsolute(resolved)).toBe(true);
      expect(fs.existsSync(resolved)).toBe(true);
    });

    it('rejects a symlinked launcher instead of crossing the trusted script boundary', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-launcher-link-'));
      const target = path.join(dir, 'target.sh');
      fs.writeFileSync(target, '#!/bin/sh\n');
      fs.symlinkSync(target, path.join(dir, 'eve-acp-launcher.sh'));
      const resolved = resolveBundledLauncherPath({ COMMAND_EVE_LAUNCHER_DIR: dir } as NodeJS.ProcessEnv, '/missing');
      expect(resolved).not.toBe(path.join(dir, 'eve-acp-launcher.sh'));
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('resolveBundledClaudeAcpTransport', () => {
    function writeBundle(resourcesPath: string, entrypoint = 'dist/index.js') {
      const runtimeKey = 'win32-x64';
      const managedRoot = path.join(resourcesPath, 'bundled-aioncore', runtimeKey, 'managed-resources');
      const nodePath = path.join(managedRoot, 'node', 'node-v24.11.0-win-x64', 'node.exe');
      const toolRoot = path.join(managedRoot, 'acp', 'claude-agent-acp', CLAUDE_ACP_ADAPTER_VERSION, runtimeKey);
      fs.mkdirSync(path.dirname(nodePath), { recursive: true });
      fs.mkdirSync(path.join(toolRoot, 'dist'), { recursive: true });
      fs.writeFileSync(nodePath, 'managed-node');
      fs.writeFileSync(path.join(toolRoot, 'dist', 'index.js'), 'managed-adapter');
      fs.writeFileSync(path.join(toolRoot, 'manifest.json'), JSON.stringify({ entrypoint, path_entries: [] }));
      return { nodePath, entrypointPath: path.join(toolRoot, 'dist', 'index.js') };
    }

    it('resolves the signed managed Node and exact embedded Claude ACP entrypoint', () => {
      const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-managed-acp-'));
      const expected = writeBundle(resourcesPath);
      expect(resolveBundledClaudeAcpTransport(resourcesPath, 'win32', 'x64')).toEqual({
        state: 'ready',
        acpCommand: expected.nodePath,
        acpArgs: [expected.entrypointPath],
      });
      fs.rmSync(resourcesPath, { recursive: true, force: true });
    });

    it('fails closed when a packaged managed-resource manifest escapes its tool root', () => {
      const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-managed-acp-invalid-'));
      writeBundle(resourcesPath, '../../../../../outside.js');
      expect(resolveBundledClaudeAcpTransport(resourcesPath, 'win32', 'x64')).toEqual({ state: 'invalid' });
      fs.rmSync(resourcesPath, { recursive: true, force: true });
    });

    it('replaces the dev bunx tuple with the bundled transport before launcher wrapping', () => {
      const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-managed-acp-wire-'));
      const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-managed-acp-state-'));
      const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-managed-acp-launcher-'));
      const expected = writeBundle(resourcesPath);
      fs.writeFileSync(path.join(launcherDir, 'eve-acp-launcher.ps1'), '# launcher');
      const env = { COMMAND_EVE_LAUNCHER_DIR: launcherDir } as NodeJS.ProcessEnv;
      const wrapped = applyLauncherWiring(
        DELEGATE,
        { 'growth-lead': { agent_id: 'growth-lead', kind: 'claude' } } as never,
        { 'growth-lead': 'active' } as never,
        { dataPath, seatId: 'seat-1', resourcesPath, env, platform: 'win32', arch: 'x64' }
      );
      expect(wrapped?.acpArgs).toContain(expected.nodePath);
      expect(wrapped?.acpArgs).toContain(expected.entrypointPath);
      expect(wrapped?.acpArgs).not.toContain('bunx');
      expect(env[HERMES_COPILOT_ACP_ARGS_ENV]).toContain(expected.entrypointPath.replaceAll('\\', '\\\\'));
      fs.rmSync(resourcesPath, { recursive: true, force: true });
      fs.rmSync(dataPath, { recursive: true, force: true });
      fs.rmSync(launcherDir, { recursive: true, force: true });
    });

    it('never falls back to bunx when a packaged candidate is missing its managed ACP bundle', () => {
      const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-managed-acp-missing-'));
      const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-managed-acp-state-'));
      const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-managed-acp-launcher-'));
      fs.writeFileSync(path.join(resourcesPath, 'app.asar'), 'packaged-marker');
      fs.writeFileSync(path.join(launcherDir, 'eve-acp-launcher.ps1'), '# launcher');
      const env = { COMMAND_EVE_LAUNCHER_DIR: launcherDir } as NodeJS.ProcessEnv;
      const wrapped = applyLauncherWiring(
        DELEGATE,
        { 'growth-lead': { agent_id: 'growth-lead', kind: 'claude' } } as never,
        { 'growth-lead': 'active' } as never,
        { dataPath, seatId: 'seat-1', resourcesPath, env, platform: 'win32', arch: 'x64' }
      );
      expect(wrapped).toBeNull();
      expect(env[HERMES_COPILOT_ACP_COMMAND_ENV]).toBeUndefined();
      expect(env[HERMES_COPILOT_ACP_ARGS_ENV]).toBeUndefined();
      fs.rmSync(resourcesPath, { recursive: true, force: true });
      fs.rmSync(dataPath, { recursive: true, force: true });
      fs.rmSync(launcherDir, { recursive: true, force: true });
    });
  });

  describe('syncEveWorkerLauncherFiles (DERIVED read-mirror)', () => {
    let dataPath = '';
    beforeEach(() => {
      __resetEveAgentTaskRegistryForTest();
      dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-state-'));
    });
    afterEach(() => {
      fs.rmSync(dataPath, { recursive: true, force: true });
    });

    it('writes a BARE status word + a 0600 token for an active claude role', () => {
      const res = syncEveWorkerLauncherFiles(
        { 'growth-lead': { agent_id: 'growth-lead', kind: 'claude' } } as never,
        { 'growth-lead': 'active' } as never,
        { dataPath, seatId: 'seat-1' }
      );
      const p = computeLauncherStatePaths(dataPath, 'seat-1', 'growth-lead');
      expect(fs.readFileSync(p.statusFile, 'utf8')).toBe('active');
      // Bare string — NOT JSON (Fable ruling: the sh launcher matches the exact word).
      expect(fs.readFileSync(p.statusFile, 'utf8').trim()).toMatch(/^(active|paused|off)$/);
      expect(res.tokensWritten).toContain('growth-lead');
      expect(fs.existsSync(p.tokenFile)).toBe(true);
      expect(fs.readFileSync(p.tokenFile, 'utf8')).toMatch(/^\S+$/);
      if (process.platform !== 'win32') {
        expect(fs.statSync(p.tokenFile).mode & 0o777).toBe(0o600);
      }
    });

    it('writes a paused status word and NO token for a paused claude role', () => {
      const res = syncEveWorkerLauncherFiles(
        { 'growth-lead': { agent_id: 'growth-lead', kind: 'claude' } } as never,
        { 'growth-lead': 'paused' } as never,
        { dataPath, seatId: 'seat-1' }
      );
      const p = computeLauncherStatePaths(dataPath, 'seat-1', 'growth-lead');
      expect(fs.readFileSync(p.statusFile, 'utf8')).toBe('paused');
      expect(res.tokensWritten).not.toContain('growth-lead');
    });

    it('A7a — never writes a token for the free house-keeper even if claude-assigned+active', () => {
      const res = syncEveWorkerLauncherFiles(
        { 'house-keeper': { agent_id: 'house-keeper', kind: 'claude' } } as never,
        { 'house-keeper': 'active' } as never,
        { dataPath, seatId: 'seat-1' }
      );
      const p = computeLauncherStatePaths(dataPath, 'seat-1', 'house-keeper');
      // Status is mirrored…
      expect(fs.readFileSync(p.statusFile, 'utf8')).toBe('active');
      // …but a free role is un-attributable: no token, ever.
      expect(res.tokensWritten).not.toContain('house-keeper');
      expect(fs.existsSync(p.tokenFile)).toBe(false);
    });

    it('ignores non-claude assignments (nothing written)', () => {
      const res = syncEveWorkerLauncherFiles(
        { 'growth-lead': { agent_id: 'growth-lead', kind: 'codex' } } as never,
        { 'growth-lead': 'active' } as never,
        { dataPath, seatId: 'seat-1' }
      );
      expect(res.tokensWritten).toHaveLength(0);
      expect(fs.existsSync(computeLauncherStatePaths(dataPath, 'seat-1', 'growth-lead').statusFile)).toBe(false);
    });

    it('H12 revocation cleanup — a role switched OFF Claude gets its stale status/token REMOVED', () => {
      syncEveWorkerLauncherFiles(
        { 'growth-lead': { agent_id: 'growth-lead', kind: 'claude' } } as never,
        { 'growth-lead': 'active' } as never,
        { dataPath, seatId: 'seat-1' }
      );
      const p = computeLauncherStatePaths(dataPath, 'seat-1', 'growth-lead');
      expect(fs.existsSync(p.statusFile)).toBe(true);
      expect(fs.existsSync(p.tokenFile)).toBe(true);

      // Revoked back to EVE-Runtime (no assignment) → files gone → the old launcher
      // fail-closes (missing expected status file → exit 3).
      syncEveWorkerLauncherFiles({} as never, {} as never, { dataPath, seatId: 'seat-1' });
      expect(fs.existsSync(p.statusFile)).toBe(false);
      expect(fs.existsSync(p.tokenFile)).toBe(false);
    });

    it('M1 paused/off — a previously-active token is REMOVED, status stays', () => {
      syncEveWorkerLauncherFiles(
        { 'growth-lead': { agent_id: 'growth-lead', kind: 'claude' } } as never,
        { 'growth-lead': 'active' } as never,
        { dataPath, seatId: 'seat-1' }
      );
      const p = computeLauncherStatePaths(dataPath, 'seat-1', 'growth-lead');
      expect(fs.existsSync(p.tokenFile)).toBe(true);

      syncEveWorkerLauncherFiles(
        { 'growth-lead': { agent_id: 'growth-lead', kind: 'claude' } } as never,
        { 'growth-lead': 'paused' } as never,
        { dataPath, seatId: 'seat-1' }
      );
      expect(fs.readFileSync(p.statusFile, 'utf8')).toBe('paused');
      expect(fs.existsSync(p.tokenFile)).toBe(false);
    });
  });
});
