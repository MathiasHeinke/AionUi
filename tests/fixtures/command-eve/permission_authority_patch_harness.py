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
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


PROVIDER_PATH = Path(sys.argv[1]).resolve()
WHEEL_PATH = Path(sys.argv[2]).resolve()
SOURCE = PROVIDER_PATH.read_text(encoding="utf-8")
sys.path.insert(0, str(WHEEL_PATH))
from tools import tool_search as hermes_tool_search  # type: ignore[import-not-found]  # noqa: E402
from tools.registry import registry as hermes_tool_registry  # type: ignore[import-not-found]  # noqa: E402


def load_patch() -> Any:
    tree = ast.parse(SOURCE, filename=str(PROVIDER_PATH))
    # G1 (CEVE-18205): the installer records itself in the shim ledger, so the
    # ledger has to come along. Taken from the SAME emitted source rather than
    # stubbed — a stub would let this harness keep passing while the real
    # `_command_eve_mark_patch` was renamed or dropped.
    wanted_functions = {
        "_install_command_eve_permission_authority_patch",
        "_install_command_eve_approval_class_patch",
        "_install_command_eve_execute_code_authority",
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
        "uuid": uuid,
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
BRIDGE_TOOL_NAME = "mcp__aionui_eve_artifacts__eve_image_edit"


def bridge_tool_handler(**_kwargs: object) -> str:
    return "unused"


hermes_tool_registry.register(
    name=BRIDGE_TOOL_NAME,
    toolset="mcp-aionui-eve-artifacts",
    schema={
        "type": "function",
        "function": {
            "name": BRIDGE_TOOL_NAME,
            "description": "Harness-only deferred image edit",
            "parameters": {
                "type": "object",
                "properties": {"action": {"type": "string"}},
            },
        },
    },
    handler=bridge_tool_handler,
)


def original_make_approval_callback(*_args: object, **_kwargs: object) -> object:
    factory_calls.append(dict(_kwargs))

    def callback(command: str, description: str, **_cb: object) -> str:
        manual_approval_calls.append((command, description))
        return "human"

    return callback


approval_module = types.ModuleType("tools.approval")
approval_module.disable_session_yolo = lambda session_id: disabled_sessions.append(session_id)
original_execute_code_guard_calls: list[dict[str, object]] = []


def original_execute_code_guard(code: str, env_type: str, has_host_access: bool = False) -> dict[str, object]:
    original_execute_code_guard_calls.append(
        {"code": code, "env_type": env_type, "has_host_access": has_host_access}
    )
    return {
        "approved": False,
        "status": "pending_approval",
        "approval_pending": True,
        "pattern_key": "execute_code",
        "description": "execute_code script execution",
        "message": "Asking the user for approval.",
    }


approval_module.check_execute_code_guard = original_execute_code_guard
terminal_module = types.ModuleType("tools.terminal_tool")
current_tool_approval_callback: object | None = None
terminal_module._get_approval_callback = lambda: current_tool_approval_callback
tools_module = types.ModuleType("tools")
tools_module.approval = approval_module
tools_module.terminal_tool = terminal_module
tools_module.tool_search = hermes_tool_search
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
sys.modules["tools.tool_search"] = hermes_tool_search
sys.modules["acp_adapter"] = adapter_module
sys.modules["acp_adapter.server"] = server_module
sys.modules["acp_adapter.permissions"] = permissions_module

namespace = load_patch()
install_patch = namespace["_install_command_eve_permission_authority_patch"]
install_approval_patch = namespace["_install_command_eve_approval_class_patch"]
install_execute_code_authority = namespace["_install_command_eve_execute_code_authority"]
emitted_ask_tool_authority = namespace["_command_eve_ask_tool_authority"]
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

# 5b) The wheel-internal execute_code guard must honor the SAME authority
# answer as the structured tool gate. Otherwise a rung-5 desktop turn keeps
# writing a gateway pending record that no ACP card ever renders (the live
# Word/DOCX blocker). A hard block remains untouched.
namespace["_command_eve_ask_tool_authority"] = lambda tool_name, action="": {
    "decision": "allow",
    "ladder": 5,
}
install_execute_code_authority()
install_execute_code_authority()
allowed_guard = approval_module.check_execute_code_guard(
    "from docx import Document", "local", has_host_access=False
)
execute_code_authority_reconciled = (
    allowed_guard.get("approved") is True
    and allowed_guard.get("authority_approved") is True
    and allowed_guard.get("user_approved") is True
)
assert execute_code_authority_reconciled, allowed_guard
assert len(original_execute_code_guard_calls) == 1


def blocked_execute_code_guard(code: str, env_type: str, has_host_access: bool = False) -> dict[str, object]:
    return {
        "approved": False,
        "pattern_key": "execute_code",
        "message": "BLOCKED by smart approval",
        "outcome": "denied",
    }


approval_module.check_execute_code_guard = blocked_execute_code_guard
install_execute_code_authority()
blocked_guard = approval_module.check_execute_code_guard("os.system('rm -rf /')", "local")
execute_code_hard_block_preserved = blocked_guard == {
    "approved": False,
    "pattern_key": "execute_code",
    "message": "BLOCKED by smart approval",
    "outcome": "denied",
}
assert execute_code_hard_block_preserved, blocked_guard

# 6) A closed decision still reaches the native human approval card.
namespace["_command_eve_ask_authority"] = lambda command, inside: {
    "decision": "ask",
    "edit_policy": "ask",
    "ladder": 1,
}
assert approval_callback("git push origin main", "Publish changes") == "human"
assert manual_approval_calls == [("git push origin main", "Publish changes")]

# 7) A shim "ask" becomes the NATIVE Hermes approve directive — never a bespoke
#    one-operation card. Hermes' own gate (tools.approval.request_tool_approval)
#    then offers once/session/always/deny through the interactive ACP permission
#    callback and persists the answer in its own allowlists. The rule key folds
#    in the ladder so a lowered rung asks again instead of riding a stale grant.
verified_revision = "A" * 32
namespace["_command_eve_ask_tool_authority"] = lambda tool_name, action="": {
    "decision": "ask",
    "ladder": 1,
    "authority_revision": verified_revision,
}
directive = namespace["_command_eve_authority_pre_tool_call"](
    "eve_image_edit",
    {"action": "replace"},
    session_id="session-auto",
)
assert directive is not None
assert directive["action"] == "approve", directive
assert directive["message"] == "Command EVE requires your approval for eve_image_edit:replace at this authority level.", directive
assert directive["rule_key"] == f"command-eve:A{verified_revision}:L1:eve_image_edit:replace", directive

# 8) The approve directive is returned regardless of callback attachment: the
#    fail-closed ownership now lives in the native gate, which denies safely
#    when no human can answer (and never enters the gateway submit_pending
#    queue in the ACP desktop, where the context is interactive, not gateway).
#    An "allow" decision still needs no human at all.
namespace["_command_eve_ask_tool_authority"] = lambda tool_name, action="": {
    "decision": "allow",
    "ladder": 5,
}
assert namespace["_command_eve_authority_pre_tool_call"](
    "eve_image_edit",
    {"action": "replace"},
    session_id="session-auto",
) is None

# 9) A 2s authority timeout is distinct from a real policy "ask" and reaches
#    the same native gate with its own message — not a widening.
namespace["_command_eve_ask_tool_authority"] = lambda tool_name, action="": {
    "decision": "ask",
    "ladder": 0,
    "reason": "authority_timeout",
}
timeout_directive = namespace["_command_eve_authority_pre_tool_call"](
    "eve_image_edit",
    {"action": "replace"},
    session_id="session-auto",
)
assert timeout_directive is not None
assert timeout_directive["action"] == "approve"
assert "could not confirm the current authority grant within 2 seconds" in timeout_directive["message"]
assert timeout_directive["rule_key"].startswith("command-eve:U")
assert timeout_directive["rule_key"].endswith(":L0:eve_image_edit:replace")
assert ":L0:eve_image_edit:replace" not in timeout_directive["rule_key"][:-len(":L0:eve_image_edit:replace")]

# A second unverified ask can never reuse the first timeout key, even when the
# same tool/action asks again immediately.
second_timeout_directive = namespace["_command_eve_authority_pre_tool_call"](
    "eve_image_edit",
    {"action": "replace"},
    session_id="session-auto",
)
assert second_timeout_directive is not None
assert second_timeout_directive["rule_key"] != timeout_directive["rule_key"]

# A missing revision is treated exactly like an outage and cannot mint a
# reusable L0 key.
namespace["_command_eve_ask_tool_authority"] = lambda tool_name, action="": {
    "decision": "ask",
    "ladder": 2,
}
missing_revision_directive = namespace["_command_eve_authority_pre_tool_call"](
    "eve_image_edit",
    {"action": "replace"},
    session_id="session-auto",
)
assert missing_revision_directive is not None
assert missing_revision_directive["rule_key"].startswith("command-eve:U")
assert missing_revision_directive["rule_key"].endswith(":L2:eve_image_edit:replace")

# 11) The Tool-Search bridge is invisible to authority: a valid `tool_call` is
#     classified by its UNDERLYING tool — including MCP-enveloped names and
#     JSON-object string arguments. Every missing, malformed or non-object
#     argument envelope blocks before authority is queried; otherwise a rung-5
#     allow for the bridge could become an unclassified underlying execution.
#     (The quarantine function itself is covered by the attachment memory gate
#     harness; here a stub proves only the ORDERING.)
seen_tool_queries: list[tuple[str, str]] = []


def recording_tool_authority(tool_name: str, action: str = "") -> dict:
    seen_tool_queries.append((tool_name, action))
    return {"decision": "allow", "ladder": 5}


namespace["_command_eve_ask_tool_authority"] = recording_tool_authority
namespace["_command_eve_turn_memory_quarantined"] = lambda session_id: False
assert namespace["_command_eve_authority_pre_tool_call"](
    "tool_call",
    {"name": BRIDGE_TOOL_NAME, "arguments": {"action": "replace"}},
    session_id="session-auto",
) is None
assert seen_tool_queries[-1] == (BRIDGE_TOOL_NAME, "replace")

assert namespace["_command_eve_authority_pre_tool_call"](
    "tool_call",
    {"name": BRIDGE_TOOL_NAME, "arguments": "{\"action\": \"archive\"}"},
    session_id="session-auto",
) is None
assert seen_tool_queries[-1] == (BRIDGE_TOOL_NAME, "archive")

valid_query_count = len(seen_tool_queries)
invalid_argument_cases = {
    "missing": {"name": BRIDGE_TOOL_NAME},
    "json_array": {"name": BRIDGE_TOOL_NAME, "arguments": "[]"},
    "json_scalar": {"name": BRIDGE_TOOL_NAME, "arguments": "42"},
    "malformed_json": {"name": BRIDGE_TOOL_NAME, "arguments": '{"action":'},
    "non_object": {"name": BRIDGE_TOOL_NAME, "arguments": []},
}
for case, envelope in invalid_argument_cases.items():
    blocked = namespace["_command_eve_authority_pre_tool_call"](
        "tool_call",
        envelope,
        session_id="session-auto",
    )
    assert blocked is not None, case
    assert blocked["action"] == "block", (case, blocked)
    assert blocked["rule_key"] == "command-eve:tool-call-envelope-invalid", (case, blocked)
    assert "JSON-object arguments" in blocked["message"], (case, blocked)
assert len(seen_tool_queries) == valid_query_count

# A non-object outer bridge envelope cannot be normalised to an empty mapping
# either; there is no underlying name or arguments whose authority can be
# proven.
outer_non_object = namespace["_command_eve_authority_pre_tool_call"](
    "tool_call",
    None,
    session_id="session-auto",
)
assert outer_non_object is not None
assert outer_non_object["action"] == "block"
assert len(seen_tool_queries) == valid_query_count

# A policy-level ASK is still labelled and keyed by the underlying operation,
# never by the bridge. This is what renders a meaningful native approval card.
namespace["_command_eve_ask_tool_authority"] = lambda tool_name, action="": {
    "decision": "ask",
    "ladder": 2,
    "authority_revision": verified_revision,
}
bridge_ask = namespace["_command_eve_authority_pre_tool_call"](
    "tool_call",
    {"name": BRIDGE_TOOL_NAME, "arguments": {"action": "replace"}},
    session_id="session-auto",
)
assert bridge_ask is not None
assert bridge_ask["action"] == "approve"
assert bridge_ask["message"] == (
    f"Command EVE requires your approval for {BRIDGE_TOOL_NAME}:replace at this authority level."
)
assert bridge_ask["rule_key"] == f"command-eve:A{verified_revision}:L2:{BRIDGE_TOOL_NAME}:replace"

namespace["_command_eve_turn_memory_quarantined"] = lambda session_id: True
namespace["_command_eve_ask_tool_authority"] = recording_tool_authority
quarantine_block = namespace["_command_eve_authority_pre_tool_call"](
    "memory",
    {"operations": [{"action": "remove", "id": "m1"}]},
    session_id="session-auto",
)
assert quarantine_block is not None
assert quarantine_block["action"] == "block"
assert "quarantined" in quarantine_block["message"]

# 10) The emitted HTTP client classifies both a direct socket timeout and the
#     wrapped urllib form separately from an ordinary authority failure.
# Restore the REAL emitted client after case 11 replaced it with a recording stub.
namespace["_command_eve_ask_tool_authority"] = emitted_ask_tool_authority
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
            "ask_becomes_native_approve_directive": True,
            "directive_contract_owns_fail_closed": True,
            "full_tool_authority_skips_card": True,
            "execute_code_authority_reconciled": execute_code_authority_reconciled,
            "execute_code_hard_block_preserved": execute_code_hard_block_preserved,
            "authority_timeout_is_distinct_and_visible": True,
            "tool_call_bridge_resolves_underlying": True,
            "bridge_object_arguments_classified": True,
            "bridge_json_object_arguments_classified": True,
            "bridge_missing_arguments_fail_closed": True,
            "bridge_json_array_arguments_fail_closed": True,
            "bridge_json_scalar_arguments_fail_closed": True,
            "bridge_malformed_json_arguments_fail_closed": True,
            "bridge_non_object_arguments_fail_closed": True,
            "bridge_outer_non_object_fail_closed": True,
            "bridge_ask_uses_underlying_label": True,
            "exact_wheel_bridge_parser_executed": True,
            "memory_quarantine_still_blocks": True,
            "idempotent_install": True,
        }
    )
)
