/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * COMPA-624 (2026-07-05) — SHARED per-seat memory for Claude DELEGATE workers.
 * The honcho MCP tool EVE has is also handed to an ACTIVE Claude delegate through
 * the eve-acp-launcher wrap (the ONLY seam — the ACP protocol hardcodes mcpServers:[]
 * and EVE's config.yaml is not read by the child adapter). Proves: per-seat isolation,
 * ready-gating, revocation symmetry, secret-free env, and the launcher --mcp-config arg.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeLauncherStatePaths,
  syncEveWorkerLauncherFiles,
  wrapClaudeDelegateWithLauncher,
} from '@/process/commandEve/eveWorkerLauncherCore';
import { buildHonchoRuntimeConfig } from '@/process/commandEve/honchoRuntimeConfigCore';
import { resolveSeatHome } from '@/process/commandEve/seatContextCore';
import type { HonchoRenderInput } from '@/process/commandEve/honchoRuntimeRenderCore';

const SEAT_A = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const SEAT_B = 'ffeeddcc-bbaa-4321-9988-776655443322';
const ROLE = 'growth-lead';
const ROSTER = [{ agent_id: ROLE }];

let DATA = '';
const roots: string[] = [];
beforeEach(() => {
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'honcho-delegate-'));
  roots.push(DATA);
});
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** A fresh-ready honcho render input for a seat (with a venv launcher). */
function readyHoncho(seatId: string): HonchoRenderInput {
  const seatHome = resolveSeatHome(DATA, seatId);
  const cfg = buildHonchoRuntimeConfig({ seatId, seatHome, hasLicense: true });
  return { ready: true, cfg, launcher: { command: '/venv/bin/python', args: ['-m', 'honcho.mcp'] } };
}

const jsonFor = (seatId: string): string => computeLauncherStatePaths(DATA, seatId, ROLE).honchoMcpConfigFile;
const activeClaude = { [ROLE]: { agent_id: ROLE, kind: 'claude' } };
const activeStatus = { [ROLE]: 'active' };

describe('delegate honcho MCP config — write + isolation + secret-free', () => {
  it('an ACTIVE claude role on a ready seat gets a honcho MCP config with THAT seat env', () => {
    syncEveWorkerLauncherFiles(
      activeClaude as never,
      activeStatus as never,
      { dataPath: DATA, seatId: SEAT_A, honcho: readyHoncho(SEAT_A) },
      ROSTER
    );
    const file = jsonFor(SEAT_A);
    expect(fs.existsSync(file)).toBe(true);
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(cfg.mcpServers.honcho.command).toBe('/venv/bin/python');
    expect(cfg.mcpServers.honcho.args).toEqual(['-m', 'honcho.mcp']);
    // Per-seat env, passwordless-loopback, NO secret.
    expect(cfg.mcpServers.honcho.env.HONCHO_WORKSPACE_ID).toBe(`ws_${SEAT_A}`);
    expect(cfg.mcpServers.honcho.env.HONCHO_DB_URI).toMatch(/^postgresql:\/\/127\.0\.0\.1:5432\/honcho_/);
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/password|secret|CEVE\.v1/i);
    // Mode 0600.
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("seat A's delegate config carries A's workspace, NEVER seat B's (isolation)", () => {
    syncEveWorkerLauncherFiles(
      activeClaude as never,
      activeStatus as never,
      { dataPath: DATA, seatId: SEAT_A, honcho: readyHoncho(SEAT_A) },
      ROSTER
    );
    syncEveWorkerLauncherFiles(
      activeClaude as never,
      activeStatus as never,
      { dataPath: DATA, seatId: SEAT_B, honcho: readyHoncho(SEAT_B) },
      ROSTER
    );
    const a = JSON.parse(fs.readFileSync(jsonFor(SEAT_A), 'utf8'));
    const b = JSON.parse(fs.readFileSync(jsonFor(SEAT_B), 'utf8'));
    expect(a.mcpServers.honcho.env.HONCHO_WORKSPACE_ID).toBe(`ws_${SEAT_A}`);
    expect(b.mcpServers.honcho.env.HONCHO_WORKSPACE_ID).toBe(`ws_${SEAT_B}`);
    expect(a.mcpServers.honcho.env.HONCHO_DB_URI).not.toBe(b.mcpServers.honcho.env.HONCHO_DB_URI);
  });

  it('a MISMATCHED cfg seat (seat B cfg under seat A path) is REFUSED (Codex cross-seat binding)', () => {
    // Craft the drift Codex feared: write for seat A but hand it seat B's honcho cfg.
    const mismatched = readyHoncho(SEAT_B); // cfg.seatId === SEAT_B
    syncEveWorkerLauncherFiles(
      activeClaude as never,
      activeStatus as never,
      { dataPath: DATA, seatId: SEAT_A, honcho: mismatched },
      ROSTER
    );
    expect(fs.existsSync(jsonFor(SEAT_A))).toBe(false); // never wrote B's memory under A's path
  });

  it('Honcho NOT ready ⇒ no delegate config written (byte-identical to before)', () => {
    syncEveWorkerLauncherFiles(
      activeClaude as never,
      activeStatus as never,
      { dataPath: DATA, seatId: SEAT_A, honcho: { ready: false } },
      ROSTER
    );
    expect(fs.existsSync(jsonFor(SEAT_A))).toBe(false);
  });

  it('no honcho input at all ⇒ no delegate config (Thread-2 inert until Honcho ready)', () => {
    syncEveWorkerLauncherFiles(
      activeClaude as never,
      activeStatus as never,
      { dataPath: DATA, seatId: SEAT_A },
      ROSTER
    );
    expect(fs.existsSync(jsonFor(SEAT_A))).toBe(false);
  });
});

describe('revocation symmetry — the honcho config is removed when the role loses eligibility', () => {
  it('a role switched away from claude has its honcho config REMOVED', () => {
    syncEveWorkerLauncherFiles(
      activeClaude as never,
      activeStatus as never,
      { dataPath: DATA, seatId: SEAT_A, honcho: readyHoncho(SEAT_A) },
      ROSTER
    );
    expect(fs.existsSync(jsonFor(SEAT_A))).toBe(true);
    // Reassign to codex → the honcho config must be gone.
    syncEveWorkerLauncherFiles(
      { [ROLE]: { agent_id: ROLE, kind: 'codex' } } as never,
      activeStatus as never,
      { dataPath: DATA, seatId: SEAT_A, honcho: readyHoncho(SEAT_A) },
      ROSTER
    );
    expect(fs.existsSync(jsonFor(SEAT_A))).toBe(false);
  });

  it('a PAUSED claude role has no loadable honcho config', () => {
    syncEveWorkerLauncherFiles(
      activeClaude as never,
      activeStatus as never,
      { dataPath: DATA, seatId: SEAT_A, honcho: readyHoncho(SEAT_A) },
      ROSTER
    );
    expect(fs.existsSync(jsonFor(SEAT_A))).toBe(true);
    syncEveWorkerLauncherFiles(
      activeClaude as never,
      { [ROLE]: 'paused' } as never,
      { dataPath: DATA, seatId: SEAT_A, honcho: readyHoncho(SEAT_A) },
      ROSTER
    );
    expect(fs.existsSync(jsonFor(SEAT_A))).toBe(false);
  });

  it('Honcho going not-ready on a still-active role REMOVES the stale config', () => {
    syncEveWorkerLauncherFiles(
      activeClaude as never,
      activeStatus as never,
      { dataPath: DATA, seatId: SEAT_A, honcho: readyHoncho(SEAT_A) },
      ROSTER
    );
    expect(fs.existsSync(jsonFor(SEAT_A))).toBe(true);
    syncEveWorkerLauncherFiles(
      activeClaude as never,
      activeStatus as never,
      { dataPath: DATA, seatId: SEAT_A, honcho: { ready: false } },
      ROSTER
    );
    expect(fs.existsSync(jsonFor(SEAT_A))).toBe(false);
  });
});

describe('wrapClaudeDelegateWithLauncher — the --mcp-config pointer', () => {
  const delegate = { agent_id: ROLE, acpCommand: 'bunx', acpArgs: ['@agentclientprotocol/claude-agent-acp'] } as never;

  it('adds --mcp-config <path> before -- when a honcho config file is given', () => {
    const wrapped = wrapClaudeDelegateWithLauncher(delegate, {
      launcherPath: '/abs/eve-acp-launcher.sh',
      statusFile: '/s',
      tokenFile: '/t',
      honchoMcpConfigFile: '/abs/growth-lead.honcho.mcp.json',
    });
    const args = wrapped.acpArgs;
    expect(args).toContain('--mcp-config');
    const mcpIdx = args.indexOf('--mcp-config');
    expect(args[mcpIdx + 1]).toBe('/abs/growth-lead.honcho.mcp.json');
    // The pointer sits BEFORE the -- separator (a launcher flag, not adapter argv).
    expect(mcpIdx).toBeLessThan(args.indexOf('--'));
  });

  it('omits --mcp-config when no honcho config file is given (byte-identical wrap)', () => {
    const wrapped = wrapClaudeDelegateWithLauncher(delegate, {
      launcherPath: '/abs/eve-acp-launcher.sh',
      statusFile: '/s',
      tokenFile: '/t',
    });
    expect(wrapped.acpArgs).not.toContain('--mcp-config');
  });
});
