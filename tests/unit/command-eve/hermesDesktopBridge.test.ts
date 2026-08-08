import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  COMMAND_EVE_ACP_PLATFORM_TOOLSETS,
  prepareCommandEveRuntimeProcessEnv,
  provisionSeatRuntimeFiles,
  resolveCommandEveRuntimeBootstrapPaths,
} from '@/process/commandEve/runtimeBootstrapCore';
import { __resetActiveSeatForTests, clearActiveSeat, setActiveSeatId } from '@/process/commandEve/seatContextCore';

const SEAT_ID = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const roots: string[] = [];

afterEach(() => {
  __resetActiveSeatForTests();
  clearActiveSeat();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const root = (): string => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-desktop-bridge-'));
  roots.push(value);
  return value;
};

describe('Hermes desktop bridge', () => {
  it('enables desktop registration while exposing only the bounded platform toolset', () => {
    const userData = root();
    const env: NodeJS.ProcessEnv = { HERMES_DESKTOP: '0' };
    setActiveSeatId(SEAT_ID);
    prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    expect(env.HERMES_DESKTOP).toBe('1');
    expect(COMMAND_EVE_ACP_PLATFORM_TOOLSETS).toContain('command-eve-desktop');
    expect(COMMAND_EVE_ACP_PLATFORM_TOOLSETS).not.toEqual(
      expect.arrayContaining(['terminal', 'kanban', 'read_terminal', 'close_terminal', 'react_to_message'])
    );
  });

  it('emits a versioned session-bound positive allowlist from the provisioned runtime', () => {
    const userData = root();
    setActiveSeatId(SEAT_ID);
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_ID);
    expect(provisionSeatRuntimeFiles({ userDataPath: userData, seatId: SEAT_ID }).ok).toBe(true);
    const config = fs.readFileSync(path.join(paths.hermesHome, 'config.yaml'), 'utf8');
    const shim = fs.readFileSync(
      path.join(paths.hermesHome, 'plugins', 'model-providers', 'custom', '__init__.py'),
      'utf8'
    );

    expect(config).toContain('    - command-eve-desktop');
    expect(shim).toContain('"tools": ["open_preview", "focus_pane"]');
    expect(shim).toContain('acp_toolset = toolsets.TOOLSETS.get("hermes-acp")');
    expect(shim).toContain('for tool_name in ("open_preview", "focus_pane")');
    expect(shim).toContain('clear_tool_cache = getattr(model_tools, "_clear_tool_defs_cache", None)');
    expect(shim).toContain('get_session_env("HERMES_SESSION_KEY", "")');
    expect(shim).toContain('SessionInfoUpdate(');
    expect(shim).toContain('"version": "command-eve-desktop-event/v1"');
    expect(shim).toContain('asyncio.run_coroutine_threadsafe');
    expect(shim).toContain('focus_pane_tool.PANES = ("files",)');
    expect(shim).not.toContain('get_session_env("HERMES_UI_SESSION_ID"');
    expect(shim).not.toContain('"tools": ["read_terminal"');
    expect(shim).not.toContain('for tool_name in ("read_terminal"');
  });
});
