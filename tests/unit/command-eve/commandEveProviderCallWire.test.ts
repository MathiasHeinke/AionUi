/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  provisionSeatRuntimeFiles,
  resolveCommandEveRuntimeBootstrapPaths,
} from '@/process/commandEve/runtimeBootstrapCore';
import { __resetActiveSeatForTests, clearActiveSeat, setActiveSeatId } from '@/process/commandEve/seatContextCore';

const REAL_UUID = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const roots: string[] = [];

afterEach(() => {
  __resetActiveSeatForTests();
  clearActiveSeat();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function runMiddlewareHarness(): Record<string, unknown> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-provider-call-wire-'));
  roots.push(root);
  setActiveSeatId(REAL_UUID);
  const paths = resolveCommandEveRuntimeBootstrapPaths(root);
  provisionSeatRuntimeFiles({ userDataPath: root, seatId: REAL_UUID });
  const providerPath = path.join(paths.hermesHome, 'plugins', 'model-providers', 'custom', '__init__.py');
  const harness = spawnSync(
    'python3',
    [path.resolve('tests/fixtures/command-eve/provider_call_identity_middleware_harness.py'), providerPath],
    { encoding: 'utf8', timeout: 15_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }
  );
  expect(harness.status, harness.stderr || harness.stdout).toBe(0);
  return JSON.parse(harness.stdout) as Record<string, unknown>;
}

describe('Command EVE provider-call correlation wire', () => {
  it('executes the emitted Hermes 0.20 middleware and stamps valid local attempts', () => {
    const result = runMiddlewareHarness();

    expect(result.first).toMatchObject({
      'x-command-eve-turn-id': 'turn-local-1',
      'x-command-eve-call-index': '1',
    });
    expect(result.retry).toEqual(result.first);
    expect(result.new_turn).toMatchObject({
      'x-command-eve-turn-id': 'turn-local-2',
      'x-command-eve-call-index': '1',
    });
    expect(result.bindings).toEqual([
      {
        session_id: 'acp-session-1',
        session_update: 'session_info_update',
        field_meta: {
          commandEveProviderTurnBinding: {
            version: 'command-eve-provider-turn-binding/v1',
            hermesTurnId: 'turn-local-1',
            requestId: 'turn-local-1:api:1',
            callIndex: 1,
            sessionId: 'acp-session-1',
          },
        },
      },
      {
        session_id: 'acp-session-1',
        session_update: 'session_info_update',
        field_meta: {
          commandEveProviderTurnBinding: {
            version: 'command-eve-provider-turn-binding/v1',
            hermesTurnId: 'turn-local-2',
            requestId: 'turn-local-2:api:1',
            callIndex: 1,
            sessionId: 'acp-session-1',
          },
        },
      },
    ]);
  });

  it('does not stamp malformed identities or public/non-custom targets', () => {
    const result = runMiddlewareHarness();

    expect(result.malformed).toEqual({});
    expect(result.public_provider).toEqual({});
    expect(result.non_custom).toEqual({});
  });
});
