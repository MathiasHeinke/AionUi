#!/usr/bin/env python3
"""Prove Command EVE exposes only web capabilities Hermes can actually serve.

The regression lives at the boundary between two exact Hermes 0.20 surfaces:

* ``tools.registry`` decides which schemas reach the model.
* ``agent.web_search_registry`` resolves providers per capability.

Hermes' bundled ``tools.web_tools`` registers ``web_search`` and
``web_extract`` with one broad check. A keyless DDGS install makes that shared
check true even though the exact bundled DDGS provider is search-only. This
harness executes the wheel's real registry, provider resolver, and DDGS class,
then lifts only Command EVE's emitted patch from the provisioned provider shim.

No provider call, network, inference, Electron, or external Python package is
used. A tiny ``ddgs`` module stub proves only the package-presence predicate
that the real provider itself uses.

Usage:
    python3 tests/fixtures/command-eve/hermes_web_capability_truth_harness.py \
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
CONFIG: dict[str, Any] = {"web": {"search_backend": "ddgs"}}


def install_module(name: str, module: types.ModuleType) -> None:
    sys.modules[name] = module
    parent_name, _, child_name = name.rpartition(".")
    if parent_name:
        setattr(sys.modules[parent_name], child_name, module)


def install_package(name: str) -> types.ModuleType:
    module = types.ModuleType(name)
    module.__path__ = []  # type: ignore[attr-defined]
    install_module(name, module)
    return module


def load_wheel_module(name: str, entry: str, package: str) -> types.ModuleType:
    with zipfile.ZipFile(WHEEL_PATH) as archive:
        source = archive.read(entry).decode("utf-8")
    module = types.ModuleType(name)
    module.__file__ = f"{WHEEL_PATH}!/{entry}"
    module.__package__ = package
    install_module(name, module)
    exec(compile(source, module.__file__, "exec"), module.__dict__)
    return module


# Package/config scaffolding used by the exact wheel modules.
install_package("tools")
install_package("agent")
install_package("plugins")
install_package("plugins.web")
install_package("plugins.web.ddgs")
install_package("hermes_cli")

config_module = types.ModuleType("hermes_cli.config")
config_module.load_config_readonly = lambda: CONFIG  # type: ignore[attr-defined]
config_module.get_env_value = lambda _name: None  # type: ignore[attr-defined]
install_module("hermes_cli.config", config_module)

secret_scope = types.ModuleType("agent.secret_scope")
secret_scope.is_multiplex_active = lambda: False  # type: ignore[attr-defined]
install_module("agent.secret_scope", secret_scope)

# Import the exact wheel implementations in dependency order.
tool_registry = load_wheel_module("tools.registry", "tools/registry.py", "tools")
web_provider = load_wheel_module(
    "agent.web_search_provider", "agent/web_search_provider.py", "agent"
)
web_registry = load_wheel_module(
    "agent.web_search_registry", "agent/web_search_registry.py", "agent"
)
ddgs_provider_module = load_wheel_module(
    "plugins.web.ddgs.provider", "plugins/web/ddgs/provider.py", "plugins.web.ddgs"
)

# DDGS's real availability check is intentionally only an import probe. The
# stub makes that probe true without installing or calling the network client.
install_module("ddgs", types.ModuleType("ddgs"))
ddgs_provider = ddgs_provider_module.DDGSWebSearchProvider()
web_registry.register_provider(ddgs_provider)

web_tools = types.ModuleType("tools.web_tools")
web_tools._ensure_web_plugins_loaded = lambda: None  # type: ignore[attr-defined]
install_module("tools.web_tools", web_tools)

tool_cache_clears = 0
model_tools = types.ModuleType("model_tools")


def clear_tool_defs_cache() -> None:
    global tool_cache_clears
    tool_cache_clears += 1


model_tools._clear_tool_defs_cache = clear_tool_defs_cache  # type: ignore[attr-defined]
install_module("model_tools", model_tools)


def broad_web_check() -> bool:
    """Mirror Hermes 0.20's shared search-or-extract availability predicate."""
    return bool(
        web_registry.get_active_search_provider() is not None
        or web_registry.get_active_extract_provider() is not None
    )


def schema(name: str) -> dict[str, Any]:
    return {
        "name": name,
        "description": f"Exact-registry harness schema for {name}",
        "parameters": {"type": "object", "properties": {}},
    }


registry = tool_registry.registry
registry.register(
    name="web_search",
    toolset="web",
    schema=schema("web_search"),
    handler=lambda _args: "search",
    check_fn=broad_web_check,
)
registry.register(
    name="web_extract",
    toolset="web",
    schema=schema("web_extract"),
    handler=lambda _args: "extract",
    check_fn=broad_web_check,
    is_async=True,
)
original_search_check = registry.get_entry("web_search").check_fn


def load_command_eve_patch() -> dict[str, Any]:
    """Lift the capability-truth installer verbatim from the emitted shim."""
    tree = ast.parse(SOURCE, filename=str(PROVIDER_PATH))
    wanted_functions = {
        "_command_eve_mark_patch",
        "_command_eve_web_extract_available",
        "_install_command_eve_web_capability_truth_patch",
    }
    wanted_globals = {"_COMMAND_EVE_INSTALLED_PATCHES"}
    body: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted_functions:
            body.append(node)
        elif (
            isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and node.target.id in wanted_globals
        ):
            body.append(node)
    namespace: dict[str, Any] = {"__name__": "command_eve_web_capability_truth_under_test"}
    exec(
        compile(ast.Module(body=body, type_ignores=[]), str(PROVIDER_PATH), "exec"),
        namespace,
    )
    return namespace


def visible_names() -> list[str]:
    definitions = registry.get_definitions({"web_search", "web_extract"}, quiet=True)
    return sorted(definition["function"]["name"] for definition in definitions)


namespace = load_command_eve_patch()
generation_before = registry._generation
namespace["_install_command_eve_web_capability_truth_patch"]()
generation_after_first_install = registry._generation

# DDGS alone must keep search visible and extract absent.
tool_registry.invalidate_check_fn_cache()
ddgs_surface = visible_names()
ddgs_extract_provider = web_registry.get_active_extract_provider()


class ExtractProvider(web_provider.WebSearchProvider):
    def __init__(self, available: bool) -> None:
        self.available = available

    @property
    def name(self) -> str:
        return "extractor"

    def is_available(self) -> bool:
        return self.available

    def supports_search(self) -> bool:
        return False

    def supports_extract(self) -> bool:
        return True

    def extract(self, urls: list[str], **_kwargs: Any) -> list[dict[str, Any]]:
        return [{"url": url, "content": "fixture"} for url in urls]


# A separately configured real extract capability must light web_extract up.
extract_provider = ExtractProvider(available=True)
web_registry.register_provider(extract_provider)
CONFIG["web"]["extract_backend"] = "extractor"
tool_registry.invalidate_check_fn_cache()
configured_extract_surface = visible_names()

# Explicit configuration is not enough: the provider must also be available.
extract_provider.available = False
tool_registry.invalidate_check_fn_cache()
unavailable_extract_surface = visible_names()

# Re-running the installer must be a no-op, including cache invalidation.
namespace["_install_command_eve_web_capability_truth_patch"]()
generation_after_second_install = registry._generation

print(
    json.dumps(
        {
            "configured_extract_surface": configured_extract_surface,
            "ddgs_extract_provider_absent": ddgs_extract_provider is None,
            "ddgs_search_only": (
                ddgs_provider.supports_search() is True
                and ddgs_provider.supports_extract() is False
                and ddgs_provider.is_available() is True
            ),
            "ddgs_surface": ddgs_surface,
            "exact_wheel_ddgs_provider_executed": (
                ddgs_provider.__class__.__module__ == "plugins.web.ddgs.provider"
            ),
            "exact_wheel_registry_executed": (
                registry.__class__.__module__ == "tools.registry"
            ),
            "idempotent_install": (
                generation_after_first_install == generation_before + 1
                and generation_after_second_install == generation_after_first_install
                and tool_cache_clears == 1
            ),
            "ledger_marked": "web_capability_truth"
            in namespace["_COMMAND_EVE_INSTALLED_PATCHES"],
            "search_check_unchanged": registry.get_entry("web_search").check_fn
            is original_search_check,
            "tool_cache_cleared": tool_cache_clears == 1,
            "unavailable_extract_surface": unavailable_extract_surface,
        },
        sort_keys=True,
    )
)
