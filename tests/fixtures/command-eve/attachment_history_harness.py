#!/usr/bin/env python3
"""Execute the Hermes 0.20 attachment-history seam without a provider."""

from __future__ import annotations

import ast
import json
import sys
import types
import zipfile
from pathlib import Path
from typing import Any, Dict, List


PROVIDER_PATH = Path(sys.argv[1]).resolve()
WHEEL_PATH = Path(sys.argv[2]).resolve()
PROVIDER_SOURCE = PROVIDER_PATH.read_text(encoding="utf-8")


def wheel_source(name: str) -> str:
    with zipfile.ZipFile(WHEEL_PATH) as wheel:
        return wheel.read(name).decode("utf-8")


def exact_wheel_agent() -> type:
    tree = ast.parse(wheel_source("run_agent.py"), filename="wheel:run_agent.py")
    agent = next(
        node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "AIAgent"
    )
    method = next(
        node
        for node in agent.body
        if isinstance(node, ast.FunctionDef)
        and node.name == "_apply_persist_user_message_override"
    )
    exact = ast.ClassDef(
        name="AIAgent",
        bases=[],
        keywords=[],
        body=[method],
        decorator_list=[],
    )
    module = ast.fix_missing_locations(ast.Module(body=[exact], type_ignores=[]))
    namespace: dict[str, object] = {
        "COMPRESSED_SUMMARY_METADATA_KEY": "_compressed_summary",
        "Dict": Dict,
        "List": List,
    }
    exec(compile(module, "wheel:run_agent.py", "exec"), namespace)
    return namespace["AIAgent"]  # type: ignore[return-value]


def exact_substitute_api_content():
    tree = ast.parse(
        wheel_source("agent/turn_context.py"), filename="wheel:agent/turn_context.py"
    )
    function = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "substitute_api_content"
    )
    module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
    namespace: dict[str, object] = {"Any": Any, "Dict": Dict}
    exec(compile(module, "wheel:agent/turn_context.py", "exec"), namespace)
    return namespace["substitute_api_content"]


def load_patch_symbols() -> dict[str, object]:
    tree = ast.parse(PROVIDER_SOURCE, filename=str(PROVIDER_PATH))
    wanted_functions = {
        "_command_eve_mark_patch",
        "_install_command_eve_attachment_history_patch",
    }
    body: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted_functions:
            body.append(node)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.target.id == "_COMMAND_EVE_INSTALLED_PATCHES":
                body.append(node)
    module = ast.fix_missing_locations(ast.Module(body=body, type_ignores=[]))
    namespace: dict[str, object] = {"Any": Any}
    exec(compile(module, str(PROVIDER_PATH), "exec"), namespace)
    return namespace


def finalize(agent_type: type, content: Any, override: Any, **metadata: Any):
    message = {"role": "user", "content": content, **metadata}
    agent = agent_type()
    agent._persist_user_message_idx = 0
    agent._persist_user_message_override = override
    agent._persist_user_message_timestamp = None
    agent._apply_persist_user_message_override([message])
    return message


rich_content = (
    "lies das PDF\n\n[Attached file: document.md]\n"
    "PAYMENT_TERM_14_DAYS"
)
clean_content = "lies das PDF"

ExactAIAgent = exact_wheel_agent()

# Prove the actual bundled 0.20 function exhibits the live bug before patching.
baseline = finalize(ExactAIAgent, rich_content, clean_content)
assert baseline["content"] == clean_content
assert "api_content" not in baseline

run_agent = types.ModuleType("run_agent")
run_agent.AIAgent = ExactAIAgent
sys.modules["run_agent"] = run_agent

namespace = load_patch_symbols()
namespace["_install_command_eve_attachment_history_patch"]()
namespace["_install_command_eve_attachment_history_patch"]()

patched = finalize(ExactAIAgent, rich_content, clean_content)
assert patched["content"] == clean_content
assert patched["api_content"] == rich_content

# The immediate next turn uses Hermes' native sidecar substitution, without a
# process restart, DB reload, reattachment, or provider call.
replay = dict(patched)
substitute_api_content = exact_substitute_api_content()
assert substitute_api_content(replay) == rich_content
assert replay["content"] == rich_content

# No redundant or destructive sidecars on sibling paths.
plain = finalize(ExactAIAgent, clean_content, clean_content)
assert "api_content" not in plain
existing = finalize(
    ExactAIAgent,
    rich_content,
    clean_content,
    api_content="PREEXISTING_API_CONTENT",
)
assert existing["api_content"] == "PREEXISTING_API_CONTENT"
multimodal = finalize(
    ExactAIAgent,
    [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}}],
    clean_content,
)
assert isinstance(multimodal["content"], list)
assert "api_content" not in multimodal
summary = finalize(
    ExactAIAgent,
    rich_content,
    clean_content,
    _compressed_summary=True,
)
assert summary["content"] == rich_content
assert "api_content" not in summary

print(
    json.dumps(
        {
            "exact_wheel_function_executed": True,
            "baseline_loses_context": True,
            "same_process_replay_preserved": True,
            "native_api_content_used": True,
            "negative_controls_passed": True,
            "ledger": sorted(namespace["_COMMAND_EVE_INSTALLED_PATCHES"]),
        }
    )
)
