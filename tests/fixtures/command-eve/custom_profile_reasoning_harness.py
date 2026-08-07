#!/usr/bin/env python3
"""Behavioral gate for the reasoning contract of Command EVE's custom provider.

G4 (CEVE-18205). Our profile REPLACES the wheel-bundled `custom` provider by name,
so whatever it fails to forward is simply lost — there is no fallback to the
bundled implementation. Hermes 0.20 taught that provider to forward an explicit
reasoning level as a TOP-LEVEL `reasoning_effort`; our override only handled the
"off" case, so a level the user picked was silently swallowed.

This harness EXECUTES the emitted `build_api_kwargs_extras` rather than reading it:
a grep for `elif effort` would pass for a branch that assigns the wrong key, the
wrong value, or sits under an unreachable condition.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

PROVIDER_PATH = Path(sys.argv[1]).resolve()
SOURCE = PROVIDER_PATH.read_text(encoding="utf-8")


def load_profile() -> Any:
    """Exec ONLY the emitted profile class, with its side-effecting deps stubbed.

    The installers and the authority gate are real patch machinery that needs a live
    Hermes; they are irrelevant to the reasoning contract and are stubbed to no-ops.
    Everything the contract actually depends on — the branch structure, the keys and
    the values — comes from the emitted source unchanged.
    """
    tree = ast.parse(SOURCE, filename=str(PROVIDER_PATH))
    class_node = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "CommandEveCustomProfile"
    )
    namespace: dict[str, object] = {
        "Any": Any,
        "urlparse": urlparse,
        "ProviderProfile": object,
    }
    # Stub every module-level helper the method calls before it reaches the
    # reasoning branches. Collected from the emitted source so a renamed installer
    # surfaces as a NameError here instead of being papered over by a fixed list.
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and (
            node.name.startswith("_install_command_eve_")
            or node.name.startswith("_require_command_eve_")
            or node.name == "_command_eve_write_patch_status"
        ):
            namespace[node.name] = lambda *_a, **_k: None

    module = ast.fix_missing_locations(ast.Module(body=[class_node], type_ignores=[]))
    exec(compile(module, str(PROVIDER_PATH), "exec"), namespace)
    profile_cls = namespace["CommandEveCustomProfile"]
    return profile_cls.__new__(profile_cls)


profile = load_profile()


def extras(reasoning_config: dict[str, object] | None) -> dict[str, object]:
    extra_body, top_level = profile.build_api_kwargs_extras(
        reasoning_config=reasoning_config,
        base_url="https://ark.example.invalid/v1",
    )
    return {"extra_body": extra_body, "top_level": top_level}


print(
    json.dumps(
        {
            # An explicit level must REACH the endpoint (the G4 defect).
            "explicit_high": extras({"enabled": True, "effort": "high"}),
            "explicit_max": extras({"enabled": True, "effort": "max"}),
            # Case/whitespace normalisation is part of the contract.
            "explicit_padded": extras({"enabled": True, "effort": "  HIGH  "}),
            # "off" keeps BOTH signals: Ollama's /v1 ignores think=False
            # (ollama#14820), so the top-level field is what actually stops it.
            "effort_none": extras({"enabled": True, "effort": "none"}),
            "disabled": extras({"enabled": False}),
            # Enabled with NO level must stay unset, so the endpoint keeps its own
            # server-side default instead of one we invented.
            "enabled_no_effort": extras({"enabled": True}),
            "no_config": extras(None),
        },
        sort_keys=True,
    )
)
