#!/usr/bin/env python3
"""Prove Command EVE rule keys against the exact bundled Hermes approval gate."""

from __future__ import annotations

import json
import os
import sys
import types
import zipfile
from pathlib import Path
from typing import Any

WHEEL_PATH = Path(sys.argv[1]).resolve()


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
terminal_module._get_approval_callback = lambda: None  # type: ignore[attr-defined]
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
session_context.get_session_env = lambda _name, default="": default  # type: ignore[attr-defined]
install_module("gateway", gateway_package)
install_module("gateway.session_context", session_context)

agent_package = types.ModuleType("agent")
agent_package.__path__ = []  # type: ignore[attr-defined]
redact_module = types.ModuleType("agent.redact")
redact_module.redact_sensitive_text = lambda value, force=False: value  # type: ignore[attr-defined]
install_module("agent", agent_package)
install_module("agent.redact", redact_module)

with zipfile.ZipFile(WHEEL_PATH) as archive:
    source = archive.read("tools/approval.py").decode("utf-8")
approval = types.ModuleType("tools.approval")
approval.__file__ = f"{WHEEL_PATH}!/tools/approval.py"  # type: ignore[attr-defined]
install_module("tools.approval", approval)
exec(compile(source, approval.__file__, "exec"), approval.__dict__)

saved_allowlists: list[set[str]] = []
approval.save_permanent_allowlist = lambda patterns: saved_allowlists.append(set(patterns))  # type: ignore[attr-defined]

os.environ.pop("HERMES_GATEWAY_SESSION", None)
os.environ["HERMES_INTERACTIVE"] = "1"
session_token = approval.set_current_session_key("authority-contract")
callback_calls: list[str] = []


def callback(_command: str, _description: str, **_kwargs: Any) -> str:
    callback_calls.append("called")
    return choices.pop(0)


# Exact key lookup plus native "always" persistence. The second call must not
# reach the human callback at all.
choices = ["always"]
old_result = approval.request_tool_approval(
    "eve_image_edit",
    "Replace the selected artifact",
    rule_key="command-eve:AOLD:L1:eve_image_edit:replace",
    approval_callback=callback,
)
assert old_result["approved"] is True, old_result
assert callback_calls == ["called"]
assert "plugin_rule:command-eve:AOLD:L1:eve_image_edit:replace" in approval._permanent_approved
assert saved_allowlists and "plugin_rule:command-eve:AOLD:L1:eve_image_edit:replace" in saved_allowlists[-1]

same_key_result = approval.request_tool_approval(
    "eve_image_edit",
    "Replace the selected artifact",
    rule_key="command-eve:AOLD:L1:eve_image_edit:replace",
    approval_callback=callback,
)
assert same_key_result["approved"] is True, same_key_result
assert callback_calls == ["called"]

# A changed authority revision is a changed native key. The old permanent
# answer must not cover it.
choices = ["deny"]
new_result = approval.request_tool_approval(
    "eve_image_edit",
    "Replace the selected artifact",
    rule_key="command-eve:ANEW:L1:eve_image_edit:replace",
    approval_callback=callback,
)
assert new_result["approved"] is False, new_result
assert callback_calls == ["called", "called"]

# Native once is one operation only; native session survives within Hermes'
# own session allowlist.
approval._permanent_approved.clear()
choices = ["once"]
once = approval.request_tool_approval("eve_image_edit", "Once", rule_key="command-eve:ONCE", approval_callback=callback)
assert once["approved"] is True, once
choices = ["deny"]
once_again = approval.request_tool_approval(
    "eve_image_edit", "Once", rule_key="command-eve:ONCE", approval_callback=callback
)
assert once_again["approved"] is False, once_again

choices = ["session"]
session_first = approval.request_tool_approval(
    "eve_image_edit", "Session", rule_key="command-eve:SESSION", approval_callback=callback
)
assert session_first["approved"] is True, session_first
session_second = approval.request_tool_approval("eve_image_edit", "Session", rule_key="command-eve:SESSION")
assert session_second["approved"] is True, session_second

# Silence and absence of a human are explicit denials, never implicit consent.
choices = ["timeout"]
timeout = approval.request_tool_approval(
    "eve_image_edit", "Timeout", rule_key="command-eve:TIMEOUT", approval_callback=callback
)
assert timeout["approved"] is False, timeout
assert timeout["outcome"] == "timeout"

os.environ.pop("HERMES_INTERACTIVE", None)
no_human = approval.request_tool_approval(
    "eve_image_edit", "No human", rule_key="command-eve:NO_HUMAN", approval_callback=None
)
assert no_human["approved"] is False, no_human
assert "no interactive user" in no_human["message"]

approval.reset_current_session_key(session_token)
print(
    json.dumps(
        {
            "exact_wheel_function_executed": True,
            "always_persists_exact_plugin_rule_key": True,
            "same_key_skips_human": True,
            "changed_key_asks_again": True,
            "once_does_not_persist": True,
            "session_persists_only_in_session": True,
            "timeout_fails_closed": True,
            "missing_human_fails_closed": True,
        }
    )
)
