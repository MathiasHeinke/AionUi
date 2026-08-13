#!/usr/bin/env python3
"""Behavioral gate for the generated provider-wait/retry metadata patch."""

from __future__ import annotations

import ast
import json
import logging
import re
import sys
import types
from pathlib import Path
from typing import Any


SOURCE_PATH = Path(sys.argv[1]).resolve()
SOURCE = SOURCE_PATH.read_text(encoding="utf-8")


def load_patch() -> dict[str, Any]:
    tree = ast.parse(SOURCE, filename=str(SOURCE_PATH))
    wanted_functions = {
        "_command_eve_mark_patch",
        "_install_command_eve_runtime_status_patch",
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
    namespace: dict[str, Any] = {"Any": Any, "logging": logging, "re": re}
    exec(compile(ast.fix_missing_locations(ast.Module(body=body, type_ignores=[])), str(SOURCE_PATH), "exec"), namespace)
    return namespace


class AIAgent:
    def __init__(self) -> None:
        self.command_eve_runtime_status_callback = None
        self.native_waits: list[str] = []
        self.buffered: list[str] = []

    def _emit_wait_notice(self, text: str) -> None:
        self.native_waits.append(text)

    def _buffer_status(self, message: str) -> None:
        self.buffered.append(message)


run_agent = types.ModuleType("run_agent")
run_agent.AIAgent = AIAgent
sys.modules["run_agent"] = run_agent

namespace = load_patch()
install = namespace["_install_command_eve_runtime_status_patch"]
install()
install()

events: list[dict[str, Any]] = []
agent = AIAgent()
agent.command_eve_runtime_status_callback = lambda payload: events.append(dict(payload))

agent._emit_wait_notice("Waiting for vendor/model — no response body after 20s")
agent._buffer_status("⏳ Retrying in 2.0s (attempt 2/3)...")
agent._buffer_status("⏱️ Rate limited. Waiting 4.5s (attempt 3/4)...")
agent._buffer_status("raw provider error: secret/model")

assert agent.native_waits == ["Waiting for vendor/model — no response body after 20s"]
assert agent.buffered[-1] == "raw provider error: secret/model"
assert events == [
    {"phase": "provider_wait"},
    {"phase": "retry_wait", "attempt": 2, "maxAttempts": 3, "retryAfterMs": 2000},
    {"phase": "retry_wait", "attempt": 3, "maxAttempts": 4, "retryAfterMs": 4500},
]
assert all("message" not in event and "provider" not in event and "model" not in event for event in events)
assert namespace["_COMMAND_EVE_INSTALLED_PATCHES"] == {"runtime_status"}

print(json.dumps({"events": events, "raw_status_forwarded": False, "idempotent_install": True}))
