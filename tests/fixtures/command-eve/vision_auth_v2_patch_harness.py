#!/usr/bin/env python3
"""Run Command EVE's auth seam against Hermes 0.20's exact wheel function."""

from __future__ import annotations

import ast
import json
import os
import re
import sys
import tempfile
import types
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


PROVIDER_PATH = Path(sys.argv[1]).resolve()
WHEEL_PATH = Path(sys.argv[2]).resolve()
SOURCE = PROVIDER_PATH.read_text(encoding="utf-8")


def load_selected_provider_symbols() -> dict[str, object]:
    tree = ast.parse(SOURCE, filename=str(PROVIDER_PATH))
    wanted_functions = {
        "_command_eve_mark_patch",
        "_command_eve_shim_token",
        "_command_eve_is_local_shim_base",
        "_install_command_eve_auxiliary_auth_patch",
    }
    wanted_globals = {"_COMMAND_EVE_INSTALLED_PATCHES"}
    body: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted_functions:
            body.append(node)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.target.id in wanted_globals:
                body.append(node)
    module = ast.fix_missing_locations(ast.Module(body=body, type_ignores=[]))
    namespace: dict[str, object] = {
        "Any": Any,
        "os": os,
        "re": re,
        "Path": Path,
        "urlparse": urlparse,
    }
    exec(compile(module, str(PROVIDER_PATH), "exec"), namespace)
    return namespace


class OtherClient:
    pass


class CapturedAsyncOpenAI:
    def __init__(self, **kwargs: Any):
        self.api_key = kwargs["api_key"]
        self.base_url = kwargs["base_url"]
        self.kwargs = kwargs


def load_exact_wheel_to_async_client():
    with zipfile.ZipFile(WHEEL_PATH) as wheel:
        source = wheel.read("agent/auxiliary_client.py").decode("utf-8")
    tree = ast.parse(source, filename=f"{WHEEL_PATH}!agent/auxiliary_client.py")
    function = next(
        node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_to_async_client"
    )
    probe_stub = next(
        (
            node
            for node in tree.body
            if isinstance(node, ast.ClassDef) and node.name == "_AuxProbeClientStub"
        ),
        None,
    )
    selected = [function] if probe_stub is None else [probe_stub, function]
    module = ast.fix_missing_locations(ast.Module(body=selected, type_ignores=[]))
    namespace: dict[str, object] = {
        "CodexAuxiliaryClient": OtherClient,
        "AsyncCodexAuxiliaryClient": OtherClient,
        "AnthropicAuxiliaryClient": OtherClient,
        "AsyncAnthropicAuxiliaryClient": OtherClient,
        "BedrockAuxiliaryClient": OtherClient,
        "AsyncBedrockAuxiliaryClient": OtherClient,
        "base_url_host_matches": lambda url, host: host in str(url),
        "build_or_headers": lambda: {},
        "_apply_user_default_headers": lambda headers: headers,
        "_openai_http_client_kwargs": lambda _url, async_mode=False: {},
    }
    exec(compile(module, str(WHEEL_PATH), "exec"), namespace)
    return namespace["_to_async_client"]


openai_module = types.ModuleType("openai")
openai_module.AsyncOpenAI = CapturedAsyncOpenAI
sys.modules["openai"] = openai_module

auxiliary_client = types.ModuleType("agent.auxiliary_client")
agent_module = types.ModuleType("agent")
agent_module.auxiliary_client = auxiliary_client
sys.modules["agent"] = agent_module
sys.modules["agent.auxiliary_client"] = auxiliary_client

namespace = load_selected_provider_symbols()
# Hermes imports provider plugins while agent.auxiliary_client can still be
# partially initialised. The first install attempt must defer without crashing;
# the normal later retry installs both hooks once the wheel module is complete.
namespace["_install_command_eve_auxiliary_auth_patch"]()
incomplete_import_safe = "auxiliary_auth" not in namespace["_COMMAND_EVE_INSTALLED_PATCHES"]
auxiliary_client._resolve_custom_runtime = lambda: (
    "http://127.0.0.1:25811/v1",
    "no-key-required",
    "chat_completions",
)
auxiliary_client._to_async_client = load_exact_wheel_to_async_client()
with tempfile.TemporaryDirectory(prefix="command-eve-vision-auth-") as tmp:
    token_file = Path(tmp) / "shim-auth-token"
    token = "a" * 64
    token_file.write_text(token, encoding="utf-8")
    os.environ["COMMAND_EVE_SHIM_AUTH_TOKEN_FILE"] = str(token_file)
    namespace["_install_command_eve_auxiliary_auth_patch"]()
    namespace["_install_command_eve_auxiliary_auth_patch"]()

    local_sync_client = types.SimpleNamespace(
        base_url="http://127.0.0.1:25811/v1", api_key="no-key-required"
    )
    client, model = auxiliary_client._to_async_client(
        local_sync_client, "minicpm-v:8b", is_vision=True
    )
    assert model == "minicpm-v:8b"
    assert client.api_key == token

    external_sync_client = types.SimpleNamespace(
        base_url="https://example.invalid/v1", api_key="external-key"
    )
    external, _ = auxiliary_client._to_async_client(
        external_sync_client, "external-model", is_vision=True
    )
    assert external.api_key == "external-key"

    token_file.write_text("not-a-token", encoding="utf-8")
    local_sync_client.api_key = "no-key-required"
    assert auxiliary_client._to_async_client(
        local_sync_client, "minicpm-v:8b", is_vision=True
    ) == (None, "minicpm-v:8b")

print(
    json.dumps(
        {
            "incomplete_import_safe": incomplete_import_safe,
            "exact_wheel_function_executed": True,
            "local_nonce_rebound": True,
            "external_key_preserved": True,
            "missing_nonce_fails_before_http": True,
            "ledger": sorted(namespace["_COMMAND_EVE_INSTALLED_PATCHES"]),
        }
    )
)
