#!/usr/bin/env python3
"""Exercise the emitted Hermes desktop bridge under overlapping ACP turns.

The provider override is the production integration seam.  This harness loads
its real desktop-bridge installer, and the exact bundled desktop_ui,
open_preview_tool, and focus_pane_tool modules, while replacing only the ACP
wire with deterministic in-process clients.  It therefore catches a
process-global emitter replacement without requiring Electron or a provider.
"""

from __future__ import annotations

import ast
import asyncio
import contextvars
import json
import sys
import types
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


PROVIDER_PATH = Path(sys.argv[1]).resolve()
WHEEL_PATH = Path(sys.argv[2]).resolve()
SOURCE = PROVIDER_PATH.read_text(encoding="utf-8")
SESSION_KEY: contextvars.ContextVar[str] = contextvars.ContextVar(
    "command_eve_test_session_key", default=""
)


def install_module(name: str, module: types.ModuleType) -> None:
    sys.modules[name] = module
    parent_name, _, child_name = name.rpartition(".")
    if parent_name:
        setattr(sys.modules[parent_name], child_name, module)


def load_wheel_module(name: str, entry: str) -> types.ModuleType:
    with zipfile.ZipFile(WHEEL_PATH) as archive:
        source = archive.read(entry).decode("utf-8")
    module = types.ModuleType(name)
    module.__file__ = f"{WHEEL_PATH}!/{entry}"
    module.__package__ = "tools"
    install_module(name, module)
    exec(compile(source, module.__file__, "exec"), module.__dict__)
    return module


class FakeRegistry:
    def __init__(self) -> None:
        self.entries: dict[str, dict[str, Any]] = {}

    def get_entry(self, name: str) -> dict[str, Any] | None:
        return self.entries.get(name)

    def register(self, **kwargs: Any) -> None:
        self.entries[str(kwargs["name"])] = dict(kwargs)


class SessionInfoUpdate:
    def __init__(self, **kwargs: Any) -> None:
        self.session_update = kwargs["session_update"]
        self.field_meta = kwargs["field_meta"]


class FakeConnection:
    def __init__(self, name: str) -> None:
        self.name = name
        self.events: list[dict[str, Any]] = []

    async def session_update(self, session_id: str, update: SessionInfoUpdate) -> None:
        await asyncio.sleep(0)
        desktop = update.field_meta["commandEveDesktop"]
        self.events.append(
            {
                "session_id": session_id,
                "version": desktop["version"],
                "event": desktop["event"],
                "payload": desktop["payload"],
            }
        )


class TurnAgent:
    def __init__(self) -> None:
        self.read_terminal_callback: object = object()
        self.original_terminal_callback = self.read_terminal_callback


class FakeSessionManager:
    def __init__(self, session_id: str, turn_agent: TurnAgent) -> None:
        self.session_id = session_id
        self.state = types.SimpleNamespace(agent=turn_agent)

    def get_session(self, session_id: str) -> object | None:
        return self.state if session_id == self.session_id else None


class HermesACPAgent:
    def __init__(self, conn: FakeConnection, session_id: str, turn_agent: TurnAgent) -> None:
        self._conn = conn
        self.session_manager = FakeSessionManager(session_id, turn_agent)

    async def _prompt_impl(self, *args: Any, **kwargs: Any) -> str:
        return await upstream_prompt(self, *args, **kwargs)


def get_session_env(name: str, default: str = "") -> str:
    if name == "HERMES_SESSION_KEY":
        return SESSION_KEY.get()
    return default


registry = FakeRegistry()


def tool_error(message: str, **_kwargs: Any) -> str:
    return json.dumps({"success": False, "error": message})


def env_var_enabled(_name: str) -> bool:
    return True


tools_package = types.ModuleType("tools")
tools_package.__path__ = []  # type: ignore[attr-defined]
install_module("tools", tools_package)
registry_module = types.ModuleType("tools.registry")
registry_module.registry = registry  # type: ignore[attr-defined]
registry_module.tool_error = tool_error  # type: ignore[attr-defined]
install_module("tools.registry", registry_module)
utils_module = types.ModuleType("utils")
utils_module.env_var_enabled = env_var_enabled  # type: ignore[attr-defined]
install_module("utils", utils_module)

gateway_package = types.ModuleType("gateway")
gateway_package.__path__ = []  # type: ignore[attr-defined]
install_module("gateway", gateway_package)
session_context_module = types.ModuleType("gateway.session_context")
session_context_module.get_session_env = get_session_env  # type: ignore[attr-defined]
install_module("gateway.session_context", session_context_module)

acp_package = types.ModuleType("acp")
acp_package.__path__ = []  # type: ignore[attr-defined]
install_module("acp", acp_package)
schema_module = types.ModuleType("acp.schema")
schema_module.SessionInfoUpdate = SessionInfoUpdate  # type: ignore[attr-defined]
install_module("acp.schema", schema_module)

acp_adapter = types.ModuleType("acp_adapter")
acp_adapter.__path__ = []  # type: ignore[attr-defined]
install_module("acp_adapter", acp_adapter)
server_module = types.ModuleType("acp_adapter.server")
server_module.HermesACPAgent = HermesACPAgent  # type: ignore[attr-defined]
install_module("acp_adapter.server", server_module)

toolsets = types.ModuleType("toolsets")
toolsets.TOOLSETS = {"hermes-acp": {"tools": []}}  # type: ignore[attr-defined]
install_module("toolsets", toolsets)

desktop_ui = load_wheel_module("tools.desktop_ui", "tools/desktop_ui.py")
open_preview_tool = load_wheel_module("tools.open_preview_tool", "tools/open_preview_tool.py")
focus_pane_tool = load_wheel_module("tools.focus_pane_tool", "tools/focus_pane_tool.py")
emitter_calls: list[object] = []
real_set_emitter = desktop_ui.set_emitter


def record_set_emitter(emitter: object) -> None:
    emitter_calls.append(emitter)
    real_set_emitter(emitter)


desktop_ui.set_emitter = record_set_emitter


def load_patch() -> dict[str, Any]:
    tree = ast.parse(SOURCE, filename=str(PROVIDER_PATH))
    wanted_functions = {
        "_command_eve_desktop_payload",
        "_command_eve_mark_patch",
        "_install_command_eve_desktop_bridge_patch",
    }
    wanted_globals = {
        "_COMMAND_EVE_DESKTOP_PANES",
        "_COMMAND_EVE_DESKTOP_CONNECTIONS_LOCK",
        "_COMMAND_EVE_DESKTOP_CONNECTIONS",
        "_COMMAND_EVE_PROVIDER_TURN_BINDINGS_SENT",
        "_COMMAND_EVE_EXPECTED_PATCHES",
        "_COMMAND_EVE_INSTALLED_PATCHES",
        "_COMMAND_EVE_READ_PREVIEW_MAX_RESPONSE_BYTES",
    }
    body: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted_functions:
            body.append(node)
        elif isinstance(node, ast.Assign) and {
            target.id for target in node.targets if isinstance(target, ast.Name)
        } & wanted_globals:
            body.append(node)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id in wanted_globals:
            body.append(node)
    namespace: dict[str, Any] = {
        "Any": Any,
        "asyncio": asyncio,
        "json": json,
        "logging": __import__("logging"),
        "threading": __import__("threading"),
        "urlparse": urlparse,
        "_command_eve_prompt_has_attachment": lambda _prompt: False,
        "_command_eve_bind_claim_quarantine_db": lambda *_args, **_kwargs: None,
        "_command_eve_enter_turn_memory_quarantine": lambda *_args, **_kwargs: None,
        "_command_eve_exit_turn_memory_quarantine": lambda *_args, **_kwargs: None,
        "_command_eve_read_terminal_callback": lambda *_args, **_kwargs: None,
    }
    exec(compile(ast.fix_missing_locations(ast.Module(body=body, type_ignores=[])), str(PROVIDER_PATH), "exec"), namespace)
    missing = wanted_functions - set(namespace)
    if missing:
        raise SystemExit(f"emitted override is missing bridge symbols: {sorted(missing)}")
    return namespace


NS = load_patch()
EVENTS: dict[str, asyncio.Event] = {}
INVALID_PAYLOAD_REJECTED = False


def assert_tool_success(value: str) -> None:
    decoded = json.loads(value)
    if decoded.get("success") is not True:
        raise AssertionError(f"desktop tool failed: {decoded}")


async def emit_bounded(label: str) -> None:
    assert_tool_success(open_preview_tool.open_preview_tool(f"https://example.test/{label}", label))
    assert_tool_success(focus_pane_tool.focus_pane_tool("files"))
    await asyncio.sleep(0)


async def upstream_prompt(_self: HermesACPAgent, *args: Any, **kwargs: Any) -> str:
    global INVALID_PAYLOAD_REJECTED
    label = str(kwargs.get("prompt") if "prompt" in kwargs else (args[0] if args else ""))
    if label == "A":
        EVENTS["a_registered"].set()
        await EVENTS["b_registered"].wait()
        await EVENTS["b_finished"].wait()
        await emit_bounded("A")
        return label
    if label == "B":
        EVENTS["b_registered"].set()
        await emit_bounded("B")
        return label
    if label == "outer":
        EVENTS["outer_registered"].set()
        await EVENTS["allow_outer_finish"].wait()
        return label
    if label == "inner":
        EVENTS["inner_registered"].set()
        await EVENTS["outer_finished"].wait()
        try:
            desktop_ui.emit("preview.open", {"url": "file:///etc/passwd", "label": "bad"})
        except ValueError:
            INVALID_PAYLOAD_REJECTED = True
        else:
            raise AssertionError("desktop payload allowlist accepted file URL")
        await emit_bounded("inner")
        return label
    raise AssertionError(f"unexpected prompt {label!r}")


async def invoke(agent: HermesACPAgent, session_id: str, prompt: str) -> str:
    token = SESSION_KEY.set(session_id)
    try:
        return await agent._prompt_impl(prompt=prompt, session_id=session_id)
    finally:
        SESSION_KEY.reset(token)


async def drain() -> None:
    for _ in range(4):
        await asyncio.sleep(0)


def event_summary(connection: FakeConnection, session_id: str, label: str) -> bool:
    return connection.events == [
        {
            "session_id": session_id,
            "version": "command-eve-desktop-event/v1",
            "event": "preview.open",
            "payload": {"url": f"https://example.test/{label}", "label": label},
        },
        {
            "session_id": session_id,
            "version": "command-eve-desktop-event/v1",
            "event": "pane.reveal",
            "payload": {"pane": "files"},
        },
    ]


async def expect_emit_failure(session_id: str) -> bool:
    token = SESSION_KEY.set(session_id)
    try:
        try:
            desktop_ui.emit("pane.reveal", {"pane": "files"})
        except RuntimeError:
            return True
        return False
    finally:
        SESSION_KEY.reset(token)


async def main() -> dict[str, bool]:
    NS["_install_command_eve_desktop_bridge_patch"]()
    NS["_install_command_eve_desktop_bridge_patch"]()

    EVENTS.update({name: asyncio.Event() for name in ("a_registered", "b_registered", "b_finished")})
    a_turn, b_turn = TurnAgent(), TurnAgent()
    connection_a, connection_b = FakeConnection("A"), FakeConnection("B")
    task_a = asyncio.create_task(invoke(HermesACPAgent(connection_a, "A", a_turn), "A", "A"))
    await EVENTS["a_registered"].wait()
    task_b = asyncio.create_task(invoke(HermesACPAgent(connection_b, "B", b_turn), "B", "B"))
    await EVENTS["b_registered"].wait()
    await task_b
    await drain()
    bridges = NS["_COMMAND_EVE_DESKTOP_CONNECTIONS"]
    b_cleanup_preserves_a = "B" not in bridges and bridges.get("A", (None,))[0] is connection_a
    EVENTS["b_finished"].set()
    await task_a
    await drain()
    overlap_ok = event_summary(connection_a, "A", "A") and event_summary(connection_b, "B", "B")
    overlap_map_cleared = not bridges

    EVENTS.update(
        {name: asyncio.Event() for name in ("outer_registered", "inner_registered", "allow_outer_finish", "outer_finished")}
    )
    old_turn, new_turn = TurnAgent(), TurnAgent()
    old_connection, new_connection = FakeConnection("same-old"), FakeConnection("same-new")
    outer_task = asyncio.create_task(invoke(HermesACPAgent(old_connection, "same", old_turn), "same", "outer"))
    await EVENTS["outer_registered"].wait()
    inner_task = asyncio.create_task(invoke(HermesACPAgent(new_connection, "same", new_turn), "same", "inner"))
    await EVENTS["inner_registered"].wait()
    EVENTS["allow_outer_finish"].set()
    await outer_task
    owner_replacement_preserved = bridges.get("same", (None,))[0] is new_connection
    EVENTS["outer_finished"].set()
    await inner_task
    await drain()
    nested_ok = event_summary(new_connection, "same", "inner") and not old_connection.events and not bridges

    return {
        # The old code installs one emitter per turn, so this asserts the actual
        # post-turn invariant rather than assuming the new installation shape.
        "stable_emitter_installed_once": len(emitter_calls) == 1,
        "overlap_routes_only_to_own_connections": overlap_ok,
        "b_cleanup_preserves_a": b_cleanup_preserves_a,
        "a_cleanup_removes_a": overlap_map_cleared,
        "unknown_context_fails_closed": await expect_emit_failure("unknown"),
        "cleared_context_fails_closed": await expect_emit_failure(""),
        "nested_owner_replacement_preserves_newer": owner_replacement_preserved and nested_ok,
        "payload_allowlist_preserved": INVALID_PAYLOAD_REJECTED,
        "terminal_callbacks_restored": all(
            turn.read_terminal_callback is turn.original_terminal_callback
            for turn in (a_turn, b_turn, old_turn, new_turn)
        ),
    }


print(json.dumps(asyncio.run(main()), sort_keys=True))
