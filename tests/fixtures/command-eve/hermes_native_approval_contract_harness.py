#!/usr/bin/env python3
"""Prove Command EVE approval through the exact bundled Hermes ACP path."""

from __future__ import annotations

import ast
import asyncio
import json
import logging
import os
import re
import sys
import threading
import types
import zipfile
from pathlib import Path
from typing import Any

WHEEL_PATH = Path(sys.argv[1]).resolve()
PROVIDER_PATH = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None


def install_module(name: str, module: types.ModuleType) -> None:
    sys.modules[name] = module
    parent, _, child = name.rpartition(".")
    if parent:
        setattr(sys.modules[parent], child, module)


utils_module = types.ModuleType("utils")
utils_module.env_var_enabled = lambda name, default="": os.getenv(name, default)  # type: ignore[attr-defined]
utils_module.is_truthy_value = lambda value: value in {1, "1", True, "true", "yes"}  # type: ignore[attr-defined]
install_module("utils", utils_module)

tools_package = types.ModuleType("tools")
tools_package.__path__ = []  # type: ignore[attr-defined]
install_module("tools", tools_package)
interrupt_module = types.ModuleType("tools.interrupt")
interrupt_module.is_interrupted = lambda: False  # type: ignore[attr-defined]
install_module("tools.interrupt", interrupt_module)
terminal_module = types.ModuleType("tools.terminal_tool")
terminal_state: dict[str, Any] = {"approval_callback": None}
terminal_module._get_approval_callback = lambda: terminal_state["approval_callback"]  # type: ignore[attr-defined]
install_module("tools.terminal_tool", terminal_module)

config_module = types.ModuleType("hermes_cli.config")
config_module.cfg_get = lambda _key, default=None: default  # type: ignore[attr-defined]
config_module.load_config = lambda: {}  # type: ignore[attr-defined]
config_module.save_config = lambda _config: None  # type: ignore[attr-defined]
config_module.load_config_readonly = lambda: {}  # type: ignore[attr-defined]
config_package = types.ModuleType("hermes_cli")
config_package.__path__ = []  # type: ignore[attr-defined]
install_module("hermes_cli", config_package)
install_module("hermes_cli.config", config_module)

gateway_package = types.ModuleType("gateway")
gateway_package.__path__ = []  # type: ignore[attr-defined]
session_context = types.ModuleType("gateway.session_context")
session_env: dict[str, str] = {}
session_context.get_session_env = lambda name, default="": session_env.get(name, default)  # type: ignore[attr-defined]
install_module("gateway", gateway_package)
install_module("gateway.session_context", session_context)

agent_package = types.ModuleType("agent")
agent_package.__path__ = []  # type: ignore[attr-defined]
redact_module = types.ModuleType("agent.redact")
redact_module.redact_sensitive_text = lambda value, force=False: value  # type: ignore[attr-defined]
install_module("agent", agent_package)
install_module("agent.redact", redact_module)


class PermissionOption:
    """Minimal ACP-SDK boundary object consumed by the exact wheel code."""

    def __init__(self, *, option_id: str, kind: str, name: str) -> None:
        if kind not in {"allow_once", "allow_always", "reject_once", "reject_always"}:
            raise ValueError(f"unsupported permission option kind: {kind}")
        self.option_id = option_id
        self.kind = kind
        self.name = name


class AllowedOutcome:
    def __init__(self, option_id: str) -> None:
        self.option_id = option_id


acp_module = types.ModuleType("acp")
acp_module.__path__ = []  # type: ignore[attr-defined]
acp_module.text_block = lambda text: {"type": "text", "text": text}  # type: ignore[attr-defined]
acp_module.tool_content = lambda block: {"type": "content", "content": block}  # type: ignore[attr-defined]
acp_module.update_tool_call = lambda tool_call_id, **kwargs: {  # type: ignore[attr-defined]
    "tool_call_id": tool_call_id,
    **kwargs,
}
acp_schema_module = types.ModuleType("acp.schema")
acp_schema_module.PermissionOption = PermissionOption  # type: ignore[attr-defined]
acp_schema_module.AllowedOutcome = AllowedOutcome  # type: ignore[attr-defined]
install_module("acp", acp_module)
install_module("acp.schema", acp_schema_module)

with zipfile.ZipFile(WHEEL_PATH) as archive:
    approval_source = archive.read("tools/approval.py").decode("utf-8")
    permissions_source = archive.read("acp_adapter/permissions.py").decode("utf-8")
    async_utils_source = archive.read("agent/async_utils.py").decode("utf-8")
    server_source = archive.read("acp_adapter/server.py").decode("utf-8")
    metadata = archive.read("hermes_agent-0.20.0.dist-info/METADATA").decode("utf-8")
assert "Version: 0.20.0" in metadata
assert "approval_cb = make_approval_callback(conn.request_permission, loop, session_id)" in server_source
assert "_terminal_tool.set_approval_callback(approval_cb)" in server_source

async_utils = types.ModuleType("agent.async_utils")
async_utils.__file__ = f"{WHEEL_PATH}!/agent/async_utils.py"  # type: ignore[attr-defined]
install_module("agent.async_utils", async_utils)
exec(compile(async_utils_source, async_utils.__file__, "exec"), async_utils.__dict__)

acp_adapter_package = types.ModuleType("acp_adapter")
acp_adapter_package.__path__ = []  # type: ignore[attr-defined]
install_module("acp_adapter", acp_adapter_package)
permissions = types.ModuleType("acp_adapter.permissions")
permissions.__file__ = f"{WHEEL_PATH}!/acp_adapter/permissions.py"  # type: ignore[attr-defined]
install_module("acp_adapter.permissions", permissions)
exec(compile(permissions_source, permissions.__file__, "exec"), permissions.__dict__)

approval = types.ModuleType("tools.approval")
approval.__file__ = f"{WHEEL_PATH}!/tools/approval.py"  # type: ignore[attr-defined]
install_module("tools.approval", approval)
exec(compile(approval_source, approval.__file__, "exec"), approval.__dict__)

saved_allowlists: list[set[str]] = []
approval.save_permanent_allowlist = lambda patterns: saved_allowlists.append(set(patterns))  # type: ignore[attr-defined]


def install_generated_approval_patch() -> None:
    assert PROVIDER_PATH is not None
    tree = ast.parse(PROVIDER_PATH.read_text(encoding="utf-8"), filename=str(PROVIDER_PATH))
    wanted_functions = {"_command_eve_mark_patch", "_install_command_eve_approval_class_patch"}
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
    namespace: dict[str, Any] = {"Any": Any, "logging": logging, "re": re}
    exec(compile(module, str(PROVIDER_PATH), "exec"), namespace)
    namespace["_install_command_eve_approval_class_patch"]()
    namespace["_install_command_eve_approval_class_patch"]()

os.environ.pop("HERMES_GATEWAY_SESSION", None)
os.environ["HERMES_INTERACTIVE"] = "1"
session_token = approval.set_current_session_key("authority-contract")
permission_choices: list[str] = []
permission_calls: list[dict[str, Any]] = []


async def request_permission(*args: Any, **kwargs: Any) -> types.SimpleNamespace:
    assert args == (), args
    assert set(kwargs) == {"session_id", "tool_call", "options"}, kwargs
    permission_calls.append(kwargs)
    choice = permission_choices.pop(0)
    if choice == "__timeout__":
        await asyncio.Event().wait()
    return types.SimpleNamespace(outcome=AllowedOutcome(choice))


loop = asyncio.new_event_loop()
loop_thread = threading.Thread(target=loop.run_forever, name="exact-wheel-acp-loop", daemon=True)
loop_thread.start()
callback = permissions.make_approval_callback(request_permission, loop, "acp-session-18234", timeout=0.05)

# Hermes 0.20 calls any non-empty HERMES_SESSION_PLATFORM a gateway. ACP is
# different: server.py already installed the native request_permission callback
# above, so routing it to the gateway queue hides the permission card. Execute
# the emitted compatibility patch against the exact wheel and prove ACP reaches
# that existing callback while real gateway platforms retain their old path.
if PROVIDER_PATH is not None:
    server_module = types.ModuleType("acp_adapter.server")
    server_module.make_approval_callback = permissions.make_approval_callback  # type: ignore[attr-defined]
    install_module("acp_adapter.server", server_module)
    session_env["HERMES_SESSION_PLATFORM"] = "acp"
    interactive_token = approval.set_hermes_interactive_context(True)
    assert approval._is_gateway_approval_context() is True
    install_generated_approval_patch()
    assert approval._is_gateway_approval_context() is False
    assert getattr(approval._is_gateway_approval_context, "_command_eve_acp_interactive_patch", False) is True
    terminal_state["approval_callback"] = permissions.make_approval_callback(
        request_permission,
        loop,
        "acp-session-native-routing",
        timeout=0.05,
    )
    permission_choices = ["allow_once"]
    native_routing_result = approval.request_tool_approval(
        "eve_image_edit",
        "Native ACP routing",
        rule_key="command-eve:NATIVE_ACP_ROUTING",
    )
    assert native_routing_result["approved"] is True, native_routing_result
    assert permission_calls[-1]["session_id"] == "acp-session-native-routing"
    session_env["HERMES_SESSION_PLATFORM"] = "slack"
    assert approval._is_gateway_approval_context() is True
    approval.reset_hermes_interactive_context(interactive_token)
    session_env.clear()
    terminal_state["approval_callback"] = None
    permission_calls.clear()


# Exact key lookup plus native "always" persistence. The second call must not
# reach the human callback at all.
permission_choices = ["allow_always"]
old_result = approval.request_tool_approval(
    "eve_image_edit",
    "Replace the selected artifact",
    rule_key="command-eve:AOLD:L1:eve_image_edit:replace",
    approval_callback=callback,
)
assert old_result["approved"] is True, old_result
assert len(permission_calls) == 1
assert "plugin_rule:command-eve:AOLD:L1:eve_image_edit:replace" in approval._permanent_approved
assert saved_allowlists and "plugin_rule:command-eve:AOLD:L1:eve_image_edit:replace" in saved_allowlists[-1]

first_call = permission_calls[0]
assert first_call["session_id"] == "acp-session-18234"
assert first_call["tool_call"]["kind"] == "execute"
assert first_call["tool_call"]["status"] == "pending"
assert first_call["tool_call"]["raw_input"] == {
    "command": "<eve_image_edit> (plugin approval rule)",
    "description": "Replace the selected artifact",
}
assert [option.option_id for option in first_call["options"]] == [
    "allow_once",
    "allow_session",
    "allow_always",
    "deny",
    "deny_always",
]

same_key_result = approval.request_tool_approval(
    "eve_image_edit",
    "Replace the selected artifact",
    rule_key="command-eve:AOLD:L1:eve_image_edit:replace",
    approval_callback=callback,
)
assert same_key_result["approved"] is True, same_key_result
assert len(permission_calls) == 1

# A changed authority revision is a changed native key. The old permanent
# answer must not cover it.
permission_choices = ["deny"]
new_result = approval.request_tool_approval(
    "eve_image_edit",
    "Replace the selected artifact",
    rule_key="command-eve:ANEW:L1:eve_image_edit:replace",
    approval_callback=callback,
)
assert new_result["approved"] is False, new_result
assert len(permission_calls) == 2

# Native once is one operation only; native session survives within Hermes'
# own session allowlist.
approval._permanent_approved.clear()
permission_choices = ["allow_once"]
once = approval.request_tool_approval("eve_image_edit", "Once", rule_key="command-eve:ONCE", approval_callback=callback)
assert once["approved"] is True, once
permission_choices = ["deny"]
once_again = approval.request_tool_approval(
    "eve_image_edit", "Once", rule_key="command-eve:ONCE", approval_callback=callback
)
assert once_again["approved"] is False, once_again

permission_choices = ["allow_session"]
session_first = approval.request_tool_approval(
    "eve_image_edit", "Session", rule_key="command-eve:SESSION", approval_callback=callback
)
assert session_first["approved"] is True, session_first
session_second = approval.request_tool_approval("eve_image_edit", "Session", rule_key="command-eve:SESSION")
assert session_second["approved"] is True, session_second

# Silence and absence of a human are explicit denials, never implicit consent.
permission_choices = ["__timeout__"]
timeout = approval.request_tool_approval(
    "eve_image_edit", "Timeout", rule_key="command-eve:TIMEOUT", approval_callback=callback
)
assert timeout["approved"] is False, timeout
assert timeout["outcome"] == "timeout"

# The same exact ACP factory must fail closed when the event loop disappears.
no_loop_calls: list[dict[str, Any]] = []


def request_permission_without_loop(*args: Any, **kwargs: Any) -> Any:
    no_loop_calls.append({"args": args, "kwargs": kwargs})
    return request_permission(*args, **kwargs)


no_loop_callback = permissions.make_approval_callback(
    request_permission_without_loop,
    None,
    "acp-session-without-loop",
    timeout=0.05,
)
no_loop_result = approval.request_tool_approval(
    "eve_image_edit",
    "No ACP loop",
    rule_key="command-eve:NO_LOOP",
    approval_callback=no_loop_callback,
)
assert no_loop_result["approved"] is False, no_loop_result
assert len(no_loop_calls) == 1

# Native callback flags must shape the ACP choices. A non-permanent prompt may
# not offer "always"; a Smart-DENY override may offer only once or deny.
permission_choices = ["allow_once"]
no_permanent = approval.prompt_dangerous_approval(
    "safe-test-command",
    "No permanent grant",
    allow_permanent=False,
    approval_callback=callback,
)
assert no_permanent == "once"
assert [option.option_id for option in permission_calls[-1]["options"]] == [
    "allow_once",
    "allow_session",
    "deny",
    "deny_always",
]

permission_choices = ["allow_once"]
smart_override = approval.prompt_dangerous_approval(
    "safe-test-command",
    "Smart denied",
    allow_permanent=False,
    approval_callback=callback,
    smart_denied=True,
)
assert smart_override == "once"
assert [option.option_id for option in permission_calls[-1]["options"]] == ["allow_once", "deny"]

os.environ.pop("HERMES_INTERACTIVE", None)
no_human = approval.request_tool_approval(
    "eve_image_edit", "No human", rule_key="command-eve:NO_HUMAN", approval_callback=None
)
assert no_human["approved"] is False, no_human
assert "no interactive user" in no_human["message"]

approval.reset_current_session_key(session_token)
loop.call_soon_threadsafe(loop.stop)
loop_thread.join(timeout=1)
assert not loop_thread.is_alive()
result = {
    "exact_wheel_function_executed": True,
    "exact_wheel_acp_callback_executed": True,
    "exact_wheel_async_bridge_executed": True,
    "exact_wheel_server_wiring_observed": True,
    "acp_request_call_shape_exact": True,
    "always_persists_exact_plugin_rule_key": True,
    "same_key_skips_human": True,
    "changed_key_asks_again": True,
    "once_does_not_persist": True,
    "session_persists_only_in_session": True,
    "timeout_fails_closed": True,
    "missing_acp_loop_fails_closed": True,
    "missing_human_fails_closed": True,
    "callback_option_scope_respected": True,
}
if PROVIDER_PATH is not None:
    result.update(
        {
            "acp_uses_native_interactive_callback": True,
            "gateway_routing_preserved": True,
        }
    )
print(json.dumps(result))
