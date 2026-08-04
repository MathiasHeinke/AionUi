/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const registered = new Map<string, (request?: unknown) => Promise<unknown>>();

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: (channel: string) => ({
      provider: (handler: (request?: unknown) => Promise<unknown>) => {
        registered.set(channel, handler);
        return { channel };
      },
    }),
  },
}));

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { get: vi.fn(() => undefined), getSync: vi.fn(() => undefined), set: vi.fn() },
  getSkillsDir: () => '/tmp/command-eve-report-stage/skills',
  getCronSkillsDir: () => '/tmp/command-eve-report-stage/cron-skills',
}));

let dataRoot = '';
vi.mock('@process/utils/utils', () => ({ getDataPath: () => dataRoot }));

import { initCommandEveBridge } from '@process/bridge/commandEveBridge';
import { __resetActiveSeatForTests, getActiveSeatId, setActiveSeatId } from '@process/commandEve/seatContextCore';
import { registerCommandEveFileSelectionGrant } from '@process/commandEve/fileSelectionGrantCore';

const SEAT_A = '11111111-1111-4111-8111-111111111111';
const SEAT_B = '22222222-2222-4222-8222-222222222222';
const tempRoots: string[] = [];
let workspace = '';
let responseConversationId = 'conv-1';
let responseWorkspace: string | undefined;
let beforeFetchResponse: (() => void) | undefined;

type StageEnvelope = {
  success: boolean;
  msg?: string;
  data?: {
    version?: string;
    ok?: boolean;
    file_name?: string;
    size_bytes?: number;
    reason_code?: string;
    [key: string]: unknown;
  };
};

const fakeFetch = vi.fn(async (input: string | URL): Promise<Response> => {
  const url = String(input);
  if (!url.endsWith('/api/conversations/conv-1')) {
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }
  beforeFetchResponse?.();
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        id: responseConversationId,
        extra: responseWorkspace === undefined ? {} : { workspace: responseWorkspace },
      },
    }),
  } as Response;
});

const call = (channel: string, request?: unknown): Promise<StageEnvelope> => {
  const provider = registered.get(channel);
  if (!provider) throw new Error(`provider not registered: ${channel}`);
  return provider(request) as Promise<StageEnvelope>;
};

beforeEach(() => {
  registered.clear();
  __resetActiveSeatForTests();
  setActiveSeatId(SEAT_A);
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-report-stage-data-'));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-report-stage-workspace-'));
  tempRoots.push(dataRoot, workspace);
  responseConversationId = 'conv-1';
  responseWorkspace = workspace;
  beforeFetchResponse = undefined;
  fakeFetch.mockClear();
  (globalThis as { __backendPort?: number }).__backendPort = 13400;
  vi.stubGlobal('fetch', fakeFetch);
  initCommandEveBridge();
});

afterEach(() => {
  __resetActiveSeatForTests();
  vi.unstubAllGlobals();
  delete (globalThis as { __backendPort?: number }).__backendPort;
  vi.clearAllMocks();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('command-eve.report-stage-workspace', () => {
  it('registers a pathless provider and stages a relative 0600 markdown child from AionCore workspace truth', async () => {
    expect(registered.has('command-eve.report-stage-workspace')).toBe(true);
    const request = {
      conversation_id: 'conv-1',
      turn_id: 'turn-1',
      tool_call_id: 'tool-call-1',
      markdown: '# Recovered report\n\nBody.',
      suggested_name: 'Client Report.pdf',
    };
    const result = await call('command-eve.report-stage-workspace', request);
    const replay = await call('command-eve.report-stage-workspace', request);

    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(String(fakeFetch.mock.calls[0]?.[0])).toBe('http://127.0.0.1:13400/api/conversations/conv-1');
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      version: 'command-eve-report-stage-workspace/v0',
      ok: true,
      size_bytes: Buffer.byteLength('# Recovered report\n\nBody.'),
    });
    expect(result.data?.file_name).toMatch(/^client-report-eve-[0-9a-f]{12}\.md$/);
    expect(replay).toEqual(result);
    expect(result).toMatchObject({
      success: true,
      data: {
        version: 'command-eve-report-stage-workspace/v0',
        ok: true,
        size_bytes: Buffer.byteLength('# Recovered report\n\nBody.'),
      },
    });
    expect(result.data).not.toHaveProperty('workspace');
    expect(result.data).not.toHaveProperty('path');
    const staged = path.join(workspace, result.data?.file_name as string);
    expect(fs.readFileSync(staged, 'utf8')).toBe('# Recovered report\n\nBody.');
    expect(fs.statSync(staged).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(workspace)).toEqual([result.data?.file_name]);
  });

  it('fails closed before lookup when turn payload identity/content/name is missing', async () => {
    const results = await Promise.all(
      [
        { markdown: '# Report', suggested_name: 'report.md' },
        {
          conversation_id: 'conv-1',
          turn_id: 'turn-1',
          tool_call_id: 'tool-call-1',
          suggested_name: 'report.md',
        },
        {
          conversation_id: 'conv-1',
          turn_id: 'turn-1',
          tool_call_id: 'tool-call-1',
          markdown: '# Report',
        },
        {
          conversation_id: 'conv-1',
          turn_id: 'turn-1',
          tool_call_id: 'tool-call-1',
          markdown: '# Report',
          suggested_name: '/tmp/report.md',
        },
      ].map((request) => call('command-eve.report-stage-workspace', request))
    );
    expect(results.every((result) => result.success === false)).toBe(true);
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it.each([
    ['missing workspace', 'conv-1', undefined, 'REPORT_STAGE_WORKSPACE_MISSING'],
    ['mismatched conversation', 'other-conversation', workspace, 'REPORT_STAGE_CONVERSATION_MISMATCH'],
  ])('fails closed for %s', async (_label, responseId, authoritativeWorkspace, reasonCode) => {
    responseConversationId = responseId;
    responseWorkspace = authoritativeWorkspace;
    const result = await call('command-eve.report-stage-workspace', {
      conversation_id: 'conv-1',
      turn_id: 'turn-1',
      tool_call_id: 'tool-call-1',
      markdown: '# Report',
      suggested_name: 'report.md',
    });
    expect(result.success).toBe(false);
    expect(result.data?.reason_code).toBe(reasonCode);
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it('rejects a seat/revision change that races the authoritative workspace fetch', async () => {
    beforeFetchResponse = () => setActiveSeatId(SEAT_B);
    const result = await call('command-eve.report-stage-workspace', {
      conversation_id: 'conv-1',
      turn_id: 'turn-1',
      tool_call_id: 'tool-call-1',
      markdown: '# Seat A report',
      suggested_name: 'report.md',
    });
    expect(getActiveSeatId()).toBe(SEAT_B);
    expect(result.success).toBe(false);
    expect(result.data?.reason_code).toBe('REPORT_STAGE_CROSS_SEAT');
    expect(fs.readdirSync(workspace)).toEqual([]);
  });
});

describe('command-eve.report-export remains the explicit native external Save-As lane', () => {
  it('still writes a user-granted target outside the conversation workspace', async () => {
    const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-report-stage-Desktop-'));
    tempRoots.push(desktopDir);
    const outputPath = path.join(desktopDir, 'explicit-export.md');
    expect(
      registerCommandEveFileSelectionGrant({
        filePath: outputPath,
        seatId: SEAT_A,
        purpose: 'write',
      })
    ).toBe(true);

    const result = await call('command-eve.report-export', {
      format: 'md',
      markdown: '# Explicit export',
      seatId: SEAT_A,
      outputPath,
      title: 'Explicit export',
    });
    expect(result.success).toBe(true);
    expect(result.data?.ok).toBe(true);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('# Explicit export');
    expect(fs.readdirSync(workspace)).toEqual([]);
  });
});
