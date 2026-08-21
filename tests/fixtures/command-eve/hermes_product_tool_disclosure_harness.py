#!/usr/bin/env python3
"""Prove the EMITTED Command EVE shim keeps the app's own tools eager.

This is the behavioural gate for the always-visible seam.  The sibling
``hermes_tool_search_disclosure_harness.py`` measures the mechanism in the
abstract; this one executes the shim Command EVE actually writes into the seat
home and then asks Hermes' OWN classifier what it made of it.

What is real here: ``tools/tool_search.py`` and ``toolsets.py`` are executed
out of the bundled wheel, and ``_install_command_eve_desktop_bridge_patch`` is
lifted verbatim out of the provisioned provider override.  Nothing about the
classification is reimplemented.

Three questions, three answers on stdout:

1. ``product_tools_deferrable`` — do the app's own tools still hide behind the
   bridge?  Must be empty.
2. ``foreign_mcp_deferrable`` — does a real third-party MCP server still defer?
   Must not be, or the seam has disarmed a mechanism it was only meant to aim.
3. ``messaging_lane_leaked_tools`` — did the mutation reach the 17 toolsets
   that share one list object with ``_HERMES_CORE_TOOLS``?  Must be empty; an
   in-place append would put ``read_terminal`` on Telegram and Signal.

No provider, no inference, no network, no Electron.

Usage:
    python3 tests/fixtures/command-eve/hermes_product_tool_disclosure_harness.py \\
        <provisioned-provider-__init__.py> <path-to-hermes_agent-0.20.0.whl>
"""

from __future__ import annotations

import ast
import json
import sys
import types
import zipfile
from pathlib import Path
from typing import Any

PROVIDER_PATH = Path(sys.argv[1]).resolve()
WHEEL_PATH = Path(sys.argv[2]).resolve()
SOURCE = PROVIDER_PATH.read_text(encoding="utf-8")

# The app-owned surface under the exact names Hermes exposes to the model.
# Built-in MCP names include server and tool prefixes; testing only the inner
# names would prove a surface that production never assembles.
PRODUCT_TOOL_NAMES = [
    "mcp__aionui_eve_artifacts__eve_artifact_get",
    "mcp__aionui_eve_artifacts__eve_artifact_list",
    "mcp__aionui_eve_artifacts__eve_typed_ui_publish",
    "mcp__aionui_eve_artifacts__eve_image_edit",
    "mcp__aionui_eve_artifacts__eve_video_edit",
    "mcp__aionui_eve_artifacts__eve_video_generate",
    "mcp__aionui_image_generation__aionui_image_generation",
    "open_preview",
    "read_preview",
    "focus_pane",
    "read_terminal",
]

# A stand-in for a real third-party MCP server.  The bridge must keep deferring
# these: that is the case progressive disclosure was built for.
FOREIGN_MCP_TOOLS = [f"supabase_{verb}" for verb in ("query", "insert", "migrate", "logs")]


def install_module(name: str, module: types.ModuleType) -> None:
    sys.modules[name] = module
    parent_name, _, child_name = name.rpartition(".")
    if parent_name:
        setattr(sys.modules[parent_name], child_name, module)


def load_wheel_module(name: str, entry: str, package: str = "tools") -> types.ModuleType:
    with zipfile.ZipFile(WHEEL_PATH) as archive:
        source = archive.read(entry).decode("utf-8")
    module = types.ModuleType(name)
    module.__file__ = f"{WHEEL_PATH}!/{entry}"
    module.__package__ = package
    install_module(name, module)
    exec(compile(source, module.__file__, "exec"), module.__dict__)
    return module


class RegistryEntry:
    """Minimal stand-in for the wheel's registry entry.

    ``tool_search.is_deferrable_tool_name`` reads exactly one field — the
    toolset name — and treats an ``mcp-`` prefix as third-party.
    """

    def __init__(self, name: str, toolset: str, schema: dict[str, Any]) -> None:
        self.name = name
        self.toolset = toolset
        self.schema = schema


class FakeRegistry:
    def __init__(self) -> None:
        self.entries: dict[str, RegistryEntry] = {}

    def get_entry(self, name: str) -> RegistryEntry | None:
        return self.entries.get(name)

    def get_schema(self, name: str) -> dict[str, Any] | None:
        entry = self.entries.get(name)
        return entry.schema if entry else None

    def register(self, **kwargs: Any) -> None:
        name = str(kwargs["name"])
        self.entries[name] = RegistryEntry(
            name, str(kwargs.get("toolset", "")), dict(kwargs.get("schema") or {})
        )


registry = FakeRegistry()


def tool_error(message: str, **kwargs: Any) -> str:
    return json.dumps({"success": False, "error": message, **kwargs})


def env_var_enabled(_name: str) -> bool:
    return True


# --- module scaffolding the wheel's imports expect -------------------------
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
session_context_module.get_session_env = lambda _name, default="": default  # type: ignore[attr-defined]
install_module("gateway.session_context", session_context_module)

acp_package = types.ModuleType("acp")
acp_package.__path__ = []  # type: ignore[attr-defined]
install_module("acp", acp_package)
schema_module = types.ModuleType("acp.schema")
schema_module.SessionInfoUpdate = type("SessionInfoUpdate", (), {})  # type: ignore[attr-defined]
install_module("acp.schema", schema_module)

acp_adapter = types.ModuleType("acp_adapter")
acp_adapter.__path__ = []  # type: ignore[attr-defined]
install_module("acp_adapter", acp_adapter)
server_module = types.ModuleType("acp_adapter.server")
# No ``_prompt_impl``: the patch installs the toolset/core wiring first and only
# then returns early at the prompt-wrapper stage.  That is precisely the part
# under test, and it keeps this harness free of the ACP turn machinery.
server_module.HermesACPAgent = type("HermesACPAgent", (), {})  # type: ignore[attr-defined]
install_module("acp_adapter.server", server_module)

# The REAL toolsets module out of the wheel, so ``_HERMES_CORE_TOOLS`` and the
# 17 toolsets that share its list object are the genuine article.
toolsets = load_wheel_module("toolsets", "toolsets.py", package="")
ts = load_wheel_module("tools.tool_search", "tools/tool_search.py")

desktop_ui = load_wheel_module("tools.desktop_ui", "tools/desktop_ui.py")
open_preview_tool = load_wheel_module("tools.open_preview_tool", "tools/open_preview_tool.py")
focus_pane_tool = load_wheel_module("tools.focus_pane_tool", "tools/focus_pane_tool.py")

# Snapshot the shared-object toolsets BEFORE the patch runs, so the leak check
# compares against truth rather than against an assumption.
SHARED_CORE_TOOLSETS = sorted(
    name
    for name, definition in toolsets.TOOLSETS.items()
    if isinstance(definition, dict) and definition.get("tools") is toolsets._HERMES_CORE_TOOLS
)
BEFORE_CORE_ID = id(toolsets._HERMES_CORE_TOOLS)


def load_patch() -> dict[str, Any]:
    """Lift the desktop-bridge installer verbatim out of the emitted shim."""
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
        "_COMMAND_EVE_READ_TERMINAL_MAX_RESPONSE_BYTES",
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
        "__name__": "command_eve_shim_under_test",
        "json": json,
        "sys": sys,
        "types": types,
    }
    for module_name in ("asyncio", "threading", "os", "time", "uuid", "sqlite3", "contextvars"):
        try:
            namespace[module_name] = __import__(module_name)
        except Exception:  # pragma: no cover — defensive
            pass
    namespace["Any"] = Any
    exec(compile(ast.Module(body=body, type_ignores=[]), str(PROVIDER_PATH), "exec"), namespace)
    return namespace


namespace = load_patch()
namespace["_install_command_eve_desktop_bridge_patch"]()


def schema_for(name: str, toolset: str) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": f"{name} ({toolset}) — sized to stand in for the real schema.",
            "parameters": {
                "type": "object",
                "properties": {"input": {"type": "string", "description": "argument"}},
                "required": ["input"],
            },
        },
    }


# The seat as the model sees it: native ACP core, the app's own tools, and one
# third-party MCP server.
tool_defs: list[dict[str, Any]] = []
for name in toolsets.TOOLSETS["hermes-acp"]["tools"]:
    if registry.get_entry(name) is None:
        registry.register(name=name, toolset="hermes-acp", schema=schema_for(name, "hermes-acp"))
    tool_defs.append(schema_for(name, "hermes-acp"))

for name in PRODUCT_TOOL_NAMES:
    if registry.get_entry(name) is None:
        toolset = "mcp-aionui-eve-artifacts" if name.startswith("mcp__") else "desktop_ui"
        registry.register(name=name, toolset=toolset, schema=schema_for(name, toolset))
    if all(td["function"]["name"] != name for td in tool_defs):
        tool_defs.append(schema_for(name, "product"))

for name in FOREIGN_MCP_TOOLS:
    registry.register(name=name, toolset="mcp-supabase", schema=schema_for(name, "mcp-supabase"))
    tool_defs.append(schema_for(name, "mcp-supabase"))

visible, deferrable = ts.classify_tools(tool_defs)
deferrable_names = {td["function"]["name"] for td in deferrable}
visible_names = {td["function"]["name"] for td in visible}
assembly = ts.assemble_tool_defs(tool_defs, context_length=262_144)
assembled_names = {td["function"]["name"] for td in assembly.tool_defs}

messaging_leaks = sorted(
    {
        name
        for toolset_name in SHARED_CORE_TOOLSETS
        for name in toolsets.TOOLSETS[toolset_name]["tools"]
        if name in set(PRODUCT_TOOL_NAMES)
    }
)

print(
    json.dumps(
        {
            # 0. Hermes ACP hardcodes the hermes-acp bundle. The emitted
            # compatibility merge must therefore make the configured native
            # desktop/clarify tools real before AIAgent snapshots schemas.
            "clarify_in_acp_surface": "clarify" in toolsets.TOOLSETS["hermes-acp"]["tools"],
            "computer_use_in_acp_surface": "computer_use"
            in toolsets.TOOLSETS["hermes-acp"]["tools"],
            # 1. The app's own tools must be eager.
            "product_tools_deferrable": sorted(deferrable_names & set(PRODUCT_TOOL_NAMES)),
            "product_tools_visible": sorted(visible_names & set(PRODUCT_TOOL_NAMES)),
            "product_tools_in_assembled_array": sorted(assembled_names & set(PRODUCT_TOOL_NAMES)),
            # 2. A third-party MCP server must still defer.
            "foreign_mcp_deferrable": sorted(deferrable_names & set(FOREIGN_MCP_TOOLS)),
            "bridge_still_armed": sorted(assembled_names & set(ts.BRIDGE_TOOL_NAMES)),
            "assembly_activated": assembly.activated,
            # 3. The rebind must not have touched the shared list object.
            "messaging_lane_leaked_tools": messaging_leaks,
            "shared_core_toolset_count": len(SHARED_CORE_TOOLSETS),
            "core_object_rebound": id(toolsets._HERMES_CORE_TOOLS) != BEFORE_CORE_ID,
        },
        indent=2,
        sort_keys=True,
    )
)
