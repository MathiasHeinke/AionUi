#!/usr/bin/env python3
"""Execute the emitted Hermes 0.20 llm_request middleware in a minimal host."""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path
from typing import Any

PROVIDER_PATH = Path(sys.argv[1]).resolve()


class ProviderProfile:
    def __init__(self, **_kwargs: Any):
        pass


class PluginManifest:
    def __init__(self, name: str):
        self.name = name


class PluginManager:
    def __init__(self) -> None:
        self._middleware: dict[str, list[Any]] = {}


MANAGER = PluginManager()


class PluginContext:
    def __init__(self, _manifest: PluginManifest, manager: PluginManager):
        self.manager = manager

    def register_middleware(self, kind: str, callback: Any) -> None:
        self.manager._middleware.setdefault(kind, []).append(callback)

    def register_hook(self, _kind: str, _callback: Any) -> None:
        pass


def install_module(name: str, module: types.ModuleType) -> None:
    sys.modules[name] = module


providers = types.ModuleType("providers")
providers.register_provider = lambda _profile: None
providers_base = types.ModuleType("providers.base")
providers_base.ProviderProfile = ProviderProfile
plugins = types.ModuleType("hermes_cli.plugins")
plugins.PluginContext = PluginContext
plugins.PluginManifest = PluginManifest
plugins.get_plugin_manager = lambda: MANAGER
middleware = types.ModuleType("hermes_cli.middleware")
middleware.LLM_REQUEST_MIDDLEWARE = "llm_request"
hermes_cli = types.ModuleType("hermes_cli")

install_module("providers", providers)
install_module("providers.base", providers_base)
install_module("hermes_cli", hermes_cli)
install_module("hermes_cli.plugins", plugins)
install_module("hermes_cli.middleware", middleware)

spec = importlib.util.spec_from_file_location("command_eve_custom_provider", PROVIDER_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError("could not load emitted provider")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

# The emitted provider installs this native middleware at import and retries it
# from the model-call hot seam. Importing is sufficient to execute the same
# registration used by a normal Hermes process without faking unrelated ACP APIs.
callbacks = MANAGER._middleware.get("llm_request", [])
if len(callbacks) != 1:
    raise RuntimeError(f"expected one llm_request callback, got {len(callbacks)}")


def apply(**context: Any) -> dict[str, str]:
    payload: dict[str, Any] = {"messages": []}
    for callback in callbacks:
        result = callback(payload, **context)
        if isinstance(result, dict) and isinstance(result.get("request"), dict):
            payload = result["request"]
    headers = payload.get("extra_headers")
    return dict(headers) if isinstance(headers, dict) else {}


local = {
    "provider": "custom",
    "api_mode": "chat_completions",
    "base_url": "http://127.0.0.1:25811/v1",
    "turn_id": "turn-local-1",
    "api_request_id": "turn-local-1:api:1",
    "api_call_count": 1,
}

print(
    json.dumps(
        {
            "first": apply(**local),
            "retry": apply(**local),
            "new_turn": apply(**{**local, "turn_id": "turn-local-2", "api_request_id": "turn-local-2:api:1"}),
            "malformed": apply(**{**local, "api_request_id": "turn-local-1:api:2"}),
            "public_provider": apply(**{**local, "base_url": "https://api.example.com/v1"}),
            "non_custom": apply(**{**local, "provider": "openai"}),
        },
        sort_keys=True,
    )
)
