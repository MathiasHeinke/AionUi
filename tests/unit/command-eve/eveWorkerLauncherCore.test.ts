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
  computeLauncherStatePaths,
  renderLauncherStatus,
  resolveBundledLauncherPath,
  syncEveWorkerLauncherFiles,
  wrapClaudeDelegateWithLauncher,
} from '../../../packages/desktop/src/process/commandEve/eveWorkerLauncherCore';
import { __resetEveAgentTaskRegistryForTest } from '../../../packages/desktop/src/process/commandEve/eveAgentTaskRegistry';
import type { ResolvedClaudeDelegate } from '../../../packages/desktop/src/common/config/eveWorkerAssignmentCore';

const DELEGATE: ResolvedClaudeDelegate = {
  agent_id: 'growth-lead',
  label: 'Claude',
  acpCommand: 'bunx',
  acpArgs: ['@agentclientprotocol/claude-agent-acp'],
  provider: 'copilot-acp',
};

describe('eveWorkerLauncherCore (SG-1 A3/A4)', () => {
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
        '@agentclientprotocol/claude-agent-acp',
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
      expect(p.statusFile).toBe('/data/eve-acp-launcher/seat-1/growth-lead.status');
      expect(p.tokenFile).toBe('/data/eve-acp-launcher/seat-1/growth-lead.token');
      expect(p.statusFile).not.toContain('/hermes/');
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
