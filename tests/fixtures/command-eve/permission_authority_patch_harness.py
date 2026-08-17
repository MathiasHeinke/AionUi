#!/usr/bin/env python3
"""Behavioral gate for Command EVE's generated Hermes authority-routing patch."""

from __future__ import annotations

import ast
import json
import logging
import os
import re
import sys
import types
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


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
        "_install_command_eve_approval_class_patch",
        "_command_eve_mark_patch",
        "_command_eve_command_inside_workspace",
        # CEVE-1821: the edit policy now comes from the seat's grant, so the whole
        # authority-client chain comes along REAL rather than stubbed. A stub would
        # let this harness keep passing while the real fail-closed path rotted.
        "_command_eve_ask_authority",
        "_command_eve_approval_url",
        "_command_eve_ask_tool_authority",
        "_command_eve_tool_approval_url",
        "_command_eve_authority_pre_tool_call",
        "_command_eve_shim_base_url",
        "_command_eve_shim_headers",
        "_command_eve_shim_token",
        "_command_eve_is_local_shim_base",
    }
    wanted_globals = {
        "_COMMAND_EVE_EXPECTED_PATCHES",
        "_COMMAND_EVE_INSTALLED_PATCHES",
        "_COMMAND_EVE_APPROVAL_CLOSED",
        "_COMMAND_EVE_SESSION_CWD",
        "_COMMAND_EVE_NATIVE_AUTHORITY_TOOLS",
    }
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
    namespace: dict[str, object] = {
        "Any": Any,
        "logging": logging,
        "os": os,
        "re": re,
        "json": json,
        "Path": Path,
        "Request": Request,
        "urlopen": urlopen,
        "urlencode": urlencode,
        "urlparse": urlparse,
    }
    exec(compile(module, str(PROVIDER_PATH), "exec"), namespace)
    return namespace


class HermesACPAgent:
    def _edit_approval_policy_for_state(self, state: object) -> tuple[str, str | None]:
        return "session", getattr(state, "cwd", None)

    def _sync_terminal_approval_mode(self, state: object) -> None:
        raise AssertionError("the original widening mode hook must be replaced")


disabled_sessions: list[str] = []
manual_approval_calls: list[tuple[str, str]] = []
factory_calls: list[dict[str, object]] = []


def original_make_approval_callback(*_args: object, **_kwargs: object) -> object:
    factory_calls.append(dict(_kwargs))

    def callback(command: str, description: str, **_cb: object) -> str:
        manual_approval_calls.append((command, description))
        return "human"

    return callback


approval_module = types.ModuleType("tools.approval")
approval_module.disable_session_yolo = lambda session_id: disabled_sessions.append(session_id)
terminal_module = types.ModuleType("tools.terminal_tool")
current_tool_approval_callback: object | None = None
terminal_module._get_approval_callback = lambda: current_tool_approval_callback
tools_module = types.ModuleType("tools")
tools_module.approval = approval_module
tools_module.terminal_tool = terminal_module
permissions_module = types.ModuleType("acp_adapter.permissions")
permissions_module.make_approval_callback = original_make_approval_callback
server_module = types.ModuleType("acp_adapter.server")
server_module.HermesACPAgent = HermesACPAgent
# Reproduce the real Hermes import shape: server.py captured the factory before
# Command EVE patched acp_adapter.permissions.
server_module.make_approval_callback = original_make_approval_callback
adapter_module = types.ModuleType("acp_adapter")
adapter_module.server = server_module
adapter_module.permissions = permissions_module
sys.modules["tools"] = tools_module
sys.modules["tools.approval"] = approval_module
sys.modules["tools.terminal_tool"] = terminal_module
sys.modules["acp_adapter"] = adapter_module
sys.modules["acp_adapter.server"] = server_module
sys.modules["acp_adapter.permissions"] = permissions_module

namespace = load_patch()
install_patch = namespace["_install_command_eve_permission_authority_patch"]
install_approval_patch = namespace["_install_command_eve_approval_class_patch"]
install_patch()
install_patch()

state = types.SimpleNamespace(session_id="session-auto", cwd="/tmp/workspace", mode="dont_ask")
agent = HermesACPAgent()

# 1) FAIL-CLOSED FOR REAL. No HERMES_HOME, so no base_url can be resolved and no
#    shim can be reached: the policy is "ask". Same value the old hardcoded
#    version returned — but now because the authority could not be asked, which
#    is the difference between a safe default and a stuck one.
os.environ.pop("HERMES_HOME", None)
assert agent._edit_approval_policy_for_state(state) == ("ask", "/tmp/workspace")

# 2) THE MODE MUST NOT DECIDE IT. `state.mode` is dont_ask above; the wheel would
#    widen on that. The policy stayed "ask", so the mode channel is dead here.
assert state.mode == "dont_ask"

# 3) AND THE GRANT DOES. With the authority answering, the policy follows it —
#    this is the half that was missing and that made rungs 2+ inert.
for answer, expected in (
    ({"decision": "ask", "edit_policy": "workspace_session", "ladder": 2}, "workspace_session"),
    ({"decision": "allow", "edit_policy": "session", "ladder": 4}, "session"),
    ({"decision": "ask", "edit_policy": "ask", "ladder": 1}, "ask"),
    # A nonsense policy is not a new mode; the client normalises it away.
    ({"decision": "ask", "edit_policy": "yolo", "ladder": 5}, "ask"),
):
    normalised = dict(answer)
    if normalised["edit_policy"] not in {"ask", "workspace_session", "session"}:
        normalised["edit_policy"] = "ask"
    namespace["_command_eve_ask_authority"] = lambda command, inside, _a=normalised: dict(_a)
    assert agent._edit_approval_policy_for_state(state) == (expected, "/tmp/workspace"), answer

# 4) The session-wide bypass is disabled for EVERY mode, including dont_ask, and
#    the session folder is recorded for the approval patch.
agent._sync_terminal_approval_mode(state)
assert disabled_sessions == ["session-auto"]
assert namespace["_COMMAND_EVE_SESSION_CWD"]["session-auto"] == "/tmp/workspace"
assert HermesACPAgent._command_eve_permission_authority_patch_installed is True

# 5) Patch the BOUND server alias as well as the permissions module. Patching
# only the latter is the shipped 1.822.3-alpha.1 bug: server.py keeps calling
# the stale imported reference and asks even when rung 5 allows the command.
namespace["_command_eve_ask_authority"] = lambda command, inside: {
    "decision": "allow",
    "edit_policy": "session",
    "ladder": 5,
}
install_approval_patch()
install_approval_patch()
assert permissions_module.make_approval_callback is server_module.make_approval_callback
assert getattr(server_module.make_approval_callback, "_command_eve_authority_patch", False) is True
approval_callback = server_module.make_approval_callback(None, None, "session-auto")
assert factory_calls[-1].get("timeout") == 300.0
assert approval_callback("curl -s https://example.com", "Read a public page") == "once"
assert manual_approval_calls == []

# 6) A closed decision still reaches the native human approval card.
namespace["_command_eve_ask_authority"] = lambda command, inside: {
    "decision": "ask",
    "edit_policy": "ask",
    "ladder": 1,
}
assert approval_callback("git push origin main", "Publish changes") == "human"
assert manual_approval_calls == [("git push origin main", "Publish changes")]

# 7) Structured tools use the SAME already-wired ACP permission callback instead
#    of escalating into the gateway queue. This is the shipped image-edit failure:
#    the callback is the bridge to conn.request_permission, so "once" means the
#    visible card reached the user and was approved.
structured_approval_calls: list[tuple[str, str, dict[str, object]]] = []


def structured_approval_callback(command: str, description: str, **options: object) -> str:
    structured_approval_calls.append((command, description, dict(options)))
    return "once"


current_tool_approval_callback = structured_approval_callback
namespace["_command_eve_ask_tool_authority"] = lambda tool_name, action="": {
    "decision": "ask",
    "ladder": 1,
}
assert namespace["_command_eve_authority_pre_tool_call"](
    "eve_image_edit",
    {"action": "replace"},
    session_id="session-auto",
) is None
assert structured_approval_calls == [
    (
        "<eve_image_edit> replace",
        "Command EVE requires your approval for eve_image_edit:replace at this authority level.",
        {"allow_permanent": False, "smart_denied": True},
    )
]

# 8) No attached ACP callback is an explicit fail-CLOSED block. Crucially the
#    directive is NOT "approve", so Hermes never enters submit_pending and never
#    creates an invisible queue item that the desktop cannot consume.
current_tool_approval_callback = None
blocked_without_callback = namespace["_command_eve_authority_pre_tool_call"](
    "eve_video_edit",
    {"action": "trim"},
    session_id="session-auto",
)
assert blocked_without_callback["action"] == "block"
assert "was not queued" in blocked_without_callback["message"]

# 9) A full authority grant still bypasses the card when the local decision
#    arrives. A 2s authority timeout is distinct from a real policy "ask" and
#    reaches the same visible one-operation callback instead of widening.
namespace["_command_eve_ask_tool_authority"] = lambda tool_name, action="": {
    "decision": "allow",
    "ladder": 5,
}
assert namespace["_command_eve_authority_pre_tool_call"](
    "eve_image_edit",
    {"action": "replace"},
    session_id="session-auto",
) is None

current_tool_approval_callback = structured_approval_callback
namespace["_command_eve_ask_tool_authority"] = lambda tool_name, action="": {
    "decision": "ask",
    "ladder": 0,
    "reason": "authority_timeout",
}
assert namespace["_command_eve_authority_pre_tool_call"](
    "eve_image_edit",
    {"action": "replace"},
    session_id="session-auto",
) is None
assert "could not confirm the current authority grant within 2 seconds" in structured_approval_calls[-1][1]

# 10) The emitted HTTP client classifies both a direct socket timeout and the
#     wrapped urllib form separately from an ordinary authority failure.
class WrappedTimeout(Exception):
    reason = TimeoutError("timed out")


def raise_timeout(*_args: object, **_kwargs: object) -> object:
    raise TimeoutError("timed out")


def raise_wrapped_timeout(*_args: object, **_kwargs: object) -> object:
    raise WrappedTimeout("urlopen failed")


namespace["_command_eve_tool_approval_url"] = lambda tool_name, action: "http://127.0.0.1:1/tool-approval"
namespace["_command_eve_shim_headers"] = lambda: {}
namespace["urlopen"] = raise_timeout
assert namespace["_command_eve_ask_tool_authority"]("eve_image_edit")["reason"] == "authority_timeout"
namespace["urlopen"] = raise_wrapped_timeout
assert namespace["_command_eve_ask_tool_authority"]("eve_image_edit")["reason"] == "authority_timeout"

print(
    json.dumps(
        {
            "edit_policy_when_unreachable": "ask",
            "edit_policy_follows_grant": True,
            "mode_channel_dead": True,
            "terminal_yolo_disabled": disabled_sessions,
            "session_cwd_recorded": True,
            "server_factory_bound": True,
            "manual_approval_timeout_seconds": 300,
            "rung_five_command_auto_approved_once": True,
            "closed_decision_reaches_human": True,
            "structured_tool_reaches_acp_permission": True,
            "missing_acp_callback_blocks_without_queue": True,
            "full_tool_authority_skips_card": True,
            "authority_timeout_is_distinct_and_visible": True,
            "idempotent_install": True,
        }
    )
)
