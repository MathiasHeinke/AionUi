/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SG-1 Design B — applyTeamManageIntent IO glue (review fixes #5/#6). Proves the
 * confirmed-intent write path: the ONE PUT under the seat-scoped key, and — the
 * review fix — that a throw AFTER the intent is consumed writes a terminal
 * apply-error receipt instead of silently dropping the confirm.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const httpRequest = vi.fn();
const syncEveWorkerLauncherFiles = vi.fn();
let dataDir = '';
let backendStatuses: Record<string, string> = {};

vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: (...a: unknown[]) => httpRequest(...a) }));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => dataDir }));
vi.mock('@/process/commandEve/seatContextCore', () => ({
  getActiveSeatId: () => 'seat-1',
  getActiveSeatKind: () => 'own_company',
}));
vi.mock('@/process/commandEve/commandEveBackendSettingsRead', () => ({
  readCommandEveSettingsFromBackend: async () => ({
    'commandEve.workerAssignments': {},
    'commandEve.teamWorkerStatus': backendStatuses,
  }),
}));
vi.mock('@/process/commandEve/eveWorkerLauncherCore', () => ({
  syncEveWorkerLauncherFiles: (...a: unknown[]) => syncEveWorkerLauncherFiles(...a),
}));

import { applyTeamManageIntent } from '@/process/commandEve/eveTeamManageMain';
import { __resetTeamManageForTest, buildProposeResponse } from '@/process/commandEve/eveTeamManageBridgeCore';
import { EVE_TEAM_ROSTER } from '@/common/config/eveTeamRoster';

const allActive = () => Object.fromEntries(EVE_TEAM_ROSTER.map((r) => [r.agent_id, 'active']));

function readReceipts(): Array<Record<string, unknown>> {
  const file = path.join(dataDir, 'eve-team-manage', 'receipts.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function propose(): string {
  backendStatuses = allActive() as Record<string, string>;
  const r = buildProposeResponse({ role_agent_id: 'growth-lead', action: 'pause' }, allActive() as never, {
    seatId: 'seat-1',
    now: Date.now(),
    randomId: () => 'INT-APPLY',
  });
  if (!r.ok) throw new Error('propose failed');
  return r.intent_id as string;
}

beforeEach(() => {
  __resetTeamManageForTest();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-apply-'));
  httpRequest.mockReset().mockResolvedValue(undefined);
  syncEveWorkerLauncherFiles.mockReset();
});
afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('applyTeamManageIntent (SG-1 Design B — the ONE write + review fixes)', () => {
  it('applies: PUTs the paused status under the seat-scoped key + writes an applied receipt', async () => {
    const id = propose();
    const res = await applyTeamManageIntent(id);
    expect(res.ok).toBe(true);

    // Exactly one PUT, to the client-settings route, with the seat-scoped key.
    expect(httpRequest).toHaveBeenCalledTimes(1);
    const [method, route, body] = httpRequest.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(method).toBe('PUT');
    expect(route).toBe('/api/settings/client');
    const key = Object.keys(body)[0];
    expect(key).toContain('commandEve.teamWorkerStatus');
    expect((body[key] as Record<string, string>)['growth-lead']).toBe('paused');

    const applied = readReceipts().find((r) => r.event === 'applied');
    expect(applied).toBeTruthy();
    expect(applied?.after).toBe('paused');
    expect(applied?.launcher_synced).toBe(true);
  });

  it('#5 — a PUT failure AFTER consume writes a terminal apply-error receipt (no silent drop)', async () => {
    const id = propose();
    httpRequest.mockRejectedValueOnce(new Error('backend down'));
    const res = await applyTeamManageIntent(id);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('error');
    const err = readReceipts().find((r) => r.event === 'apply-error');
    expect(err).toBeTruthy();
    expect(String(err?.error)).toContain('backend down');
  });

  it('#6 — a launcher-sync failure is recorded honestly (launcher_synced:false) but the apply still succeeds', async () => {
    const id = propose();
    syncEveWorkerLauncherFiles.mockImplementationOnce(() => {
      throw new Error('fs blip');
    });
    const res = await applyTeamManageIntent(id);
    expect(res.ok).toBe(true); // the authoritative PUT succeeded
    const applied = readReceipts().find((r) => r.event === 'applied');
    expect(applied?.launcher_synced).toBe(false);
  });

  it('refuses a consumed/absent intent with an apply-refused receipt', async () => {
    const res = await applyTeamManageIntent('never-existed');
    expect(res.ok).toBe(false);
    expect(readReceipts().some((r) => r.event === 'apply-refused')).toBe(true);
    expect(httpRequest).not.toHaveBeenCalled();
  });
});
