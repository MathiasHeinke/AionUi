/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HONCHO-Inc.3 / P4 — the per-seat mcp_servers entry. Pins NO-FALSE-READINESS
 * (undefined unless ready + configured) and PER-SEAT ISOLATION (two seats ⇒
 * disjoint env; no secret in the entry).
 */

import { describe, expect, it } from 'vitest';
import { HONCHO_MCP_SERVER_ID, honchoMcpServerForSeat } from '@/process/commandEve/honchoMcpServerCore';
import { buildHonchoRuntimeConfig } from '@/process/commandEve/honchoRuntimeConfigCore';
import { resolveSeatHome } from '@/process/commandEve/seatContextCore';

const USER_DATA = '/tmp/command-eve-honcho-mcp-test';
const SEAT_A = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const SEAT_B = 'ffeeddcc-bbaa-4321-9988-776655443322';
const LAUNCHER = { command: '/venv/bin/python', args: ['-m', 'honcho.mcp'] };

function cfgFor(seatId: string) {
  return buildHonchoRuntimeConfig({ seatId, seatHome: resolveSeatHome(USER_DATA, seatId), hasLicense: true });
}

describe('honchoMcpServerCore — no false readiness', () => {
  it('returns undefined unless ready===true', () => {
    expect(honchoMcpServerForSeat(cfgFor(SEAT_A), false, LAUNCHER)).toBeUndefined();
    expect(honchoMcpServerForSeat(cfgFor(SEAT_A), undefined as unknown as boolean, LAUNCHER)).toBeUndefined();
  });
  it('returns undefined without a launcher command (can not spawn)', () => {
    expect(honchoMcpServerForSeat(cfgFor(SEAT_A), true, undefined)).toBeUndefined();
    expect(honchoMcpServerForSeat(cfgFor(SEAT_A), true, { command: '  ' })).toBeUndefined();
  });
  it('returns undefined for a missing/partial config', () => {
    expect(honchoMcpServerForSeat(undefined, true, LAUNCHER)).toBeUndefined();
    expect(honchoMcpServerForSeat({ dbUri: 'x' }, true, LAUNCHER)).toBeUndefined();
  });
});

describe('honchoMcpServerCore — ready entry + per-seat isolation', () => {
  it('builds a stdio entry with the per-seat env when ready', () => {
    const s = honchoMcpServerForSeat(cfgFor(SEAT_A), true, LAUNCHER);
    expect(s).toBeDefined();
    expect(s?.id).toBe(HONCHO_MCP_SERVER_ID);
    expect(s?.command).toBe('/venv/bin/python');
    expect(s?.args).toEqual(['-m', 'honcho.mcp']);
    expect(s?.env?.HONCHO_WORKSPACE_ID).toBe(`ws_${SEAT_A}`);
    expect(s?.env?.HONCHO_DB_URI).toMatch(/^postgresql:\/\/127\.0\.0\.1:\d+\/honcho_[0-9a-f]{16}$/);
    expect(s?.env?.HONCHO_HOME).toContain(`seats/${SEAT_A}`);
  });

  it('two seats get DISJOINT env (db + workspace + home)', () => {
    const a = honchoMcpServerForSeat(cfgFor(SEAT_A), true, LAUNCHER);
    const b = honchoMcpServerForSeat(cfgFor(SEAT_B), true, LAUNCHER);
    expect(a?.env?.HONCHO_DB_URI).not.toBe(b?.env?.HONCHO_DB_URI);
    expect(a?.env?.HONCHO_WORKSPACE_ID).not.toBe(b?.env?.HONCHO_WORKSPACE_ID);
    expect(a?.env?.HONCHO_HOME).not.toBe(b?.env?.HONCHO_HOME);
  });

  it('the entry carries NO password / secret (dbUri is passwordless peer auth)', () => {
    const s = honchoMcpServerForSeat(cfgFor(SEAT_A), true, LAUNCHER);
    const json = JSON.stringify(s);
    expect(json).not.toContain('@'); // no user:pass@ in the dbUri
    expect(json.toLowerCase()).not.toContain('password');
  });

  it('REJECTS a passwordful dbUri rather than leak it into env (Codex #1)', () => {
    const tainted = { dbUri: 'postgresql://u:secret@127.0.0.1:5432/honcho_a', workspaceId: 'ws_a', honchoHome: '/h' };
    expect(honchoMcpServerForSeat(tainted, true, LAUNCHER)).toBeUndefined();
  });

  it('honors cfg.ready === false (does not advertise a config that can not authenticate — Codex #5)', () => {
    // a cloud config without a license has ready:false
    const notReadyCfg = buildHonchoRuntimeConfig({ seatId: SEAT_A, seatHome: resolveSeatHome(USER_DATA, SEAT_A), hasLicense: false });
    expect(notReadyCfg.ready).toBe(false);
    expect(honchoMcpServerForSeat(notReadyCfg, true, LAUNCHER)).toBeUndefined();
  });
});
