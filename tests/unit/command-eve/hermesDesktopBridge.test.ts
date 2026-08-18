import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
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
  it('keeps the full native Hermes surface and adds the Command EVE desktop bridge', () => {
    const userData = root();
    const env: NodeJS.ProcessEnv = { HERMES_DESKTOP: '0' };
    setActiveSeatId(SEAT_ID);
    prepareCommandEveRuntimeProcessEnv(userData, env, 'darwin');
    expect(env.HERMES_DESKTOP).toBe('1');
    expect(COMMAND_EVE_ACP_PLATFORM_TOOLSETS).toEqual(
      expect.arrayContaining(['hermes-acp', 'computer_use', 'clarify', 'command-eve-desktop'])
    );
    // Vision is exposed only after a verified local-VLM receipt. Unknown text
    // models must not inherit Hermes' optimistic vision fallback.
    expect(COMMAND_EVE_ACP_PLATFORM_TOOLSETS).not.toContain('vision');
    expect(COMMAND_EVE_ACP_PLATFORM_TOOLSETS).not.toContain('kanban');
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
    expect(config).toContain('    - hermes-acp');
    expect(shim).toContain('"tools": ["open_preview", "read_preview", "focus_pane"]');
    expect(shim).toContain('acp_toolset = toolsets.TOOLSETS.get("hermes-acp")');
    expect(shim).toContain('for tool_name in ("open_preview", "read_preview", "focus_pane", "read_terminal")');
    expect(shim).toContain('clear_tool_cache = getattr(model_tools, "_clear_tool_defs_cache", None)');
    expect(shim).toContain('get_session_env("HERMES_SESSION_KEY", "")');
    expect(shim).toContain('SessionInfoUpdate(');
    expect(shim).toContain('"version": "command-eve-desktop-event/v1"');
    expect(shim).toContain('asyncio.run_coroutine_threadsafe');
    expect(shim).toContain('_COMMAND_EVE_DESKTOP_PANES = {"chat", "files", "terminal", "review", "sessions"}');
    expect(shim).toContain('_COMMAND_EVE_PROVIDER_TURN_BINDINGS_SENT: set[tuple[str, str]] = set()');
    expect(shim).toContain('def _command_eve_bind_claim_quarantine_db(');
    expect(shim).toContain('def _command_eve_exit_turn_memory_quarantine(');
    expect(shim).toContain('pane not in _COMMAND_EVE_DESKTOP_PANES');
    expect(shim).toContain('focus_pane_tool.PANES = ("chat", "files", "terminal", "review", "sessions")');
    expect(shim).not.toContain('get_session_env("HERMES_UI_SESSION_ID"');
  });

  it('backports only the strict session-bound Hermes read_preview contract', () => {
    const userData = root();
    setActiveSeatId(SEAT_ID);
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_ID);
    expect(provisionSeatRuntimeFiles({ userDataPath: userData, seatId: SEAT_ID }).ok).toBe(true);
    const shim = fs.readFileSync(
      path.join(paths.hermesHome, 'plugins', 'model-providers', 'custom', '__init__.py'),
      'utf8'
    );

    expect(shim).toContain('_COMMAND_EVE_READ_PREVIEW_VERSION = "command-eve-read-preview/v1"');
    expect(shim).toContain('_COMMAND_EVE_READ_PREVIEW_MAX_CHARS = 24_000');
    expect(shim).toContain('_COMMAND_EVE_READ_PREVIEW_MAX_RESPONSE_BYTES = 32 * 1024');
    expect(shim).toContain('_COMMAND_EVE_READ_PREVIEW_TIMEOUT_SECONDS = 45');
    expect(shim).toContain('conn.ext_method("command_eve/read_preview", params)');
    expect(shim).toContain('set(response) != {"version", "request_id", "session_id", "result"}');
    expect(shim).toContain('response.get("request_id") != request_id');
    expect(shim).toContain('response.get("session_id") != session_id');
    expect(shim).toContain('future.cancel()');
    expect(shim).toContain('_COMMAND_EVE_DESKTOP_CONNECTIONS.pop(session_id, None)');
    expect(shim).not.toMatch(/conn\.ext_method\((event|method|name)/);
    expect(shim).not.toContain('command_eve/execute');
  });

  it('adds session-bound terminal visibility without duplicating native Hermes terminal execution', () => {
    const userData = root();
    setActiveSeatId(SEAT_ID);
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_ID);
    expect(provisionSeatRuntimeFiles({ userDataPath: userData, seatId: SEAT_ID }).ok).toBe(true);
    const shim = fs.readFileSync(
      path.join(paths.hermesHome, 'plugins', 'model-providers', 'custom', '__init__.py'),
      'utf8'
    );

    expect(shim).toContain('_COMMAND_EVE_READ_TERMINAL_VERSION = "command-eve-read-terminal/v1"');
    expect(shim).toContain('_COMMAND_EVE_READ_TERMINAL_MAX_LINES = 24_000');
    expect(shim).toContain('_COMMAND_EVE_READ_TERMINAL_MAX_RESPONSE_BYTES = 32 * 1024');
    expect(shim).toContain('_COMMAND_EVE_READ_TERMINAL_TIMEOUT_SECONDS = 45');
    expect(shim).toContain('conn.ext_method("command_eve/read_terminal", params)');
    expect(shim).toContain('def _command_eve_read_terminal_callback(start: Any = None, count: Any = None)');
    expect(shim).toContain('agent.read_terminal_callback = _command_eve_read_terminal_callback');
    expect(shim).toContain('Hermes 0.20 already owns ``read_terminal``');
    expect(shim).toContain('def _command_eve_authority_pre_tool_call(');
    expect(shim).toContain('_COMMAND_EVE_NATIVE_AUTHORITY_TOOLS');
    expect(shim).toContain('if normalized_tool == "todo"');
    expect(shim).toContain('/command-eve/tool-approval?');
    expect(shim).toContain('context.register_hook("pre_tool_call", _command_eve_authority_pre_tool_call)');
    expect(shim).toContain('"action": "approve",');
    expect(shim).toContain('rule_scope = f"A{revision}" if revision else f"U{uuid.uuid4().hex}"');
    expect(shim).toContain('"rule_key": f"command-eve:{rule_scope}:L{ladder}:{label}",');
    expect(shim).not.toContain('cb["smart_denied"] = True');
    expect(shim).not.toContain('cb["allow_permanent"] = False');
    expect(shim).not.toContain('handler=lambda args, **_kw: _command_eve_read_terminal_tool(args)');
    expect(shim).not.toContain('name="read_terminal"');
    expect(shim).not.toContain('name="write_terminal"');
    expect(shim).not.toContain('name="close_terminal"');
    expect(shim).not.toContain('name="start_terminal"');
  });

  it('routes overlapping real-provider desktop events through the task-local ACP session owner', () => {
    const userData = root();
    setActiveSeatId(SEAT_ID);
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_ID);
    expect(provisionSeatRuntimeFiles({ userDataPath: userData, seatId: SEAT_ID }).ok).toBe(true);
    const providerOverridePath = path.join(paths.hermesHome, 'plugins', 'model-providers', 'custom', '__init__.py');
    const bundledWheelPath = path.resolve('resources', 'bundled-hermes', 'hermes_agent-0.20.0-py3-none-any.whl');

    const harness = spawnSync(
      'python3',
      [
        path.resolve('tests/fixtures/command-eve/hermes_desktop_bridge_concurrency_harness.py'),
        providerOverridePath,
        bundledWheelPath,
      ],
      { encoding: 'utf8', timeout: 15_000 }
    );

    expect(harness.status, harness.stderr || harness.stdout).toBe(0);
    expect(JSON.parse(harness.stdout)).toEqual({
      a_cleanup_removes_a: true,
      b_cleanup_preserves_a: true,
      cleared_context_fails_closed: true,
      nested_owner_replacement_preserves_newer: true,
      overlap_routes_only_to_own_connections: true,
      payload_allowlist_preserved: true,
      stable_emitter_installed_once: true,
      terminal_callbacks_restored: true,
      unknown_context_fails_closed: true,
    });
  });

  it('keeps the app-owned tools eager while the bridge stays armed for third-party MCP', () => {
    const userData = root();
    setActiveSeatId(SEAT_ID);
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_ID);
    expect(provisionSeatRuntimeFiles({ userDataPath: userData, seatId: SEAT_ID }).ok).toBe(true);
    const providerOverridePath = path.join(paths.hermesHome, 'plugins', 'model-providers', 'custom', '__init__.py');
    const bundledWheelPath = path.resolve('resources', 'bundled-hermes', 'hermes_agent-0.20.0-py3-none-any.whl');

    const harness = spawnSync(
      'python3',
      [
        path.resolve('tests/fixtures/command-eve/hermes_product_tool_disclosure_harness.py'),
        providerOverridePath,
        bundledWheelPath,
      ],
      { encoding: 'utf8', timeout: 30_000 }
    );

    expect(harness.status, harness.stderr || harness.stdout).toBe(0);
    const result = JSON.parse(harness.stdout);

    // 1. Command EVE's own surface must never sit behind tool_search. Every one
    //    of these was deferrable before the always-visible seam existed, which
    //    is what made a trivial artifact request cost extra model rounds — each
    //    one a fully buffered wait on the metered lane.
    expect(result.product_tools_deferrable).toEqual([]);
    expect(result.product_tools_in_assembled_array).toEqual([
      'aionui_image_generation',
      'eve_artifact_get',
      'eve_artifact_list',
      'eve_image_edit',
      'eve_typed_ui_publish',
      'eve_video_edit',
      'eve_video_generate',
      'focus_pane',
      'open_preview',
      'read_preview',
      'read_terminal',
    ]);

    // 2. The mechanism is aimed, not disabled: a real third-party MCP server
    //    still defers, and the three bridge tools are still in the array.
    expect(result.foreign_mcp_deferrable).toEqual([
      'supabase_insert',
      'supabase_logs',
      'supabase_migrate',
      'supabase_query',
    ]);
    expect(result.assembly_activated).toBe(true);
    expect(result.bridge_still_armed).toEqual(['tool_call', 'tool_describe', 'tool_search']);

    // 3. THE REASON IT IS A REBIND. 17 wheel toolsets — hermes-cli, hermes-cron
    //    and the messaging lanes — share ONE list object with the core names. An
    //    in-place append would hand Telegram and Signal read_terminal and the
    //    video tools. A new binding leaves every one of them untouched.
    expect(result.core_object_rebound).toBe(true);
    expect(result.messaging_lane_leaked_tools).toEqual([]);
    expect(result.shared_core_toolset_count).toBeGreaterThanOrEqual(10);
  });

  it('binds Hermes 0.20 clarify to exact visible ACP choices without widening authority', () => {
    const userData = root();
    setActiveSeatId(SEAT_ID);
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData, SEAT_ID);
    expect(provisionSeatRuntimeFiles({ userDataPath: userData, seatId: SEAT_ID }).ok).toBe(true);
    const shimPath = path.join(paths.hermesHome, 'plugins', 'model-providers', 'custom', '__init__.py');
    const shim = fs.readFileSync(shimPath, 'utf8');

    expect(shim).toContain('def _command_eve_acp_clarify_callback(');
    expect(shim).toContain('def _install_command_eve_acp_clarify_patch() -> None:');
    expect(shim).toContain('getattr(acp_server, "HERMES_VERSION", "") or "") != "0.20.0"');
    expect(shim).toContain('artifact_followup:(image|video|word|excel)');
    expect(shim).toContain('"artifact_followup" if artifact_mode else "clarify"');
    expect(shim).toContain('metadata["artifact_mode"] = artifact_mode');
    expect(shim).toContain('"source_user_turn": source_user_turn');
    expect(shim).toContain('artifact follow-up clarify requires exactly one action choice');
    expect(shim).toContain('clarify_entry.schema = {');
    expect(shim).toContain('"required": ["question", "choices"]');
    expect(shim).toContain('"additionalProperties": False');
    expect(shim).not.toContain('"multi_select": {');
    expect(shim).toContain('kind="allow_once"');
    expect(shim).toContain('kind="reject_once", name="Cancel"');
    expect(shim).not.toContain('clarify_callback=approval_cb');

    const callback = shim.slice(
      shim.indexOf('def _command_eve_acp_clarify_callback('),
      shim.indexOf('def _command_eve_visible_source_user_turn(')
    );
    expect(callback).not.toMatch(/allow_always|spend_permit|tool_authority|capability_handle/);
    expect(callback).toContain('"interaction_kind"');
    expect(callback).toContain('"question"');
    expect(callback).toContain('"choices"');
    expect(callback).toContain('"source_user_turn"');

    const compiled = spawnSync('python3', ['-m', 'py_compile', shimPath], { encoding: 'utf8' });
    expect(compiled.status, compiled.stderr).toBe(0);
  });
});
