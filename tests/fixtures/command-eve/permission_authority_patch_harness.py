#!/usr/bin/env python3
"""Behavioral gate for Command EVE's generated Hermes authority-routing patch."""

from __future__ import annotations

import ast
import json
import logging
import sys
import types
from pathlib import Path
from typing import Any


PROVIDER_PATH = Path(sys.argv[1]).resolve()
SOURCE = PROVIDER_PATH.read_text(encoding="utf-8")


def load_patch() -> Any:
    tree = ast.parse(SOURCE, filename=str(PROVIDER_PATH))
    # G1 (CEVE-18205): the installer records itself in the shim ledger, so the
    # ledger has to come along. Taken from the SAME emitted source rather than
    # stubbed — a stub would let this harness keep passing while the real
    # `_command_eve_mark_patch` was renamed or dropped.
    wanted_functions = {
        "_install_command_eve_permission_authority_patch",
        "_command_eve_mark_patch",
    }
    wanted_globals = {"_COMMAND_EVE_EXPECTED_PATCHES", "_COMMAND_EVE_INSTALLED_PATCHES"}
    body: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted_functions:
            body.append(node)
        elif isinstance(node, ast.Assign) and {
            target.id for target in node.targets if isinstance(target, ast.Name)
        } & wanted_globals:
            body.append(node)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id in wanted_globals:
            body.append(node)
    module = ast.fix_missing_locations(ast.Module(body=body, type_ignores=[]))
    namespace: dict[str, object] = {"Any": Any, "logging": logging}
    exec(compile(module, str(PROVIDER_PATH), "exec"), namespace)
    return namespace["_install_command_eve_permission_authority_patch"]


class HermesACPAgent:
    def _edit_approval_policy_for_state(self, state: object) -> tuple[str, str | None]:
        return "session", getattr(state, "cwd", None)

    def _sync_terminal_approval_mode(self, state: object) -> None:
        raise AssertionError("the original widening mode hook must be replaced")


disabled_sessions: list[str] = []
approval_module = types.ModuleType("tools.approval")
approval_module.disable_session_yolo = lambda session_id: disabled_sessions.append(session_id)
tools_module = types.ModuleType("tools")
tools_module.approval = approval_module
server_module = types.ModuleType("acp_adapter.server")
server_module.HermesACPAgent = HermesACPAgent
adapter_module = types.ModuleType("acp_adapter")
adapter_module.server = server_module
sys.modules["tools"] = tools_module
sys.modules["tools.approval"] = approval_module
sys.modules["acp_adapter"] = adapter_module
sys.modules["acp_adapter.server"] = server_module

install_patch = load_patch()
install_patch()
install_patch()

state = types.SimpleNamespace(session_id="session-auto", cwd="/tmp/workspace", mode="dont_ask")
agent = HermesACPAgent()
assert agent._edit_approval_policy_for_state(state) == ("ask", "/tmp/workspace")
agent._sync_terminal_approval_mode(state)
assert disabled_sessions == ["session-auto"]
assert HermesACPAgent._command_eve_permission_authority_patch_installed is True

print(
    json.dumps(
        {
            "edit_policy": "ask",
            "terminal_yolo_disabled": disabled_sessions,
            "idempotent_install": True,
        }
    )
)
