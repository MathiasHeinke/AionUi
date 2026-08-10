#!/usr/bin/env python3
"""Behavioral gate for the narrow per-turn attachment memory rule."""

from __future__ import annotations

import ast
import json
import sys
import types
from pathlib import Path
from typing import Any


PROVIDER_PATH = Path(sys.argv[1]).resolve()
SOURCE = PROVIDER_PATH.read_text(encoding="utf-8")


def load_selected_symbols() -> dict[str, object]:
    tree = ast.parse(SOURCE, filename=str(PROVIDER_PATH))
    wanted_functions = {
        "_command_eve_mark_patch",
        "_command_eve_prompt_has_attachment",
        "_install_command_eve_attachment_memory_gate",
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
    namespace: dict[str, object] = {"Any": Any}
    exec(compile(module, str(PROVIDER_PATH), "exec"), namespace)
    return namespace


review_calls: list[dict[str, object]] = []


class AIAgent:
    def _spawn_background_review(
        self,
        messages_snapshot: Any,
        review_memory: bool = False,
        review_skills: bool = False,
    ):
        review_calls.append(
            {
                "messages_snapshot": messages_snapshot,
                "review_memory": review_memory,
                "review_skills": review_skills,
            }
        )
        return "spawned"


run_agent = types.ModuleType("run_agent")
run_agent.AIAgent = AIAgent
sys.modules["run_agent"] = run_agent

namespace = load_selected_symbols()
namespace["_install_command_eve_attachment_memory_gate"]()
namespace["_install_command_eve_attachment_memory_gate"]()

resource = types.SimpleNamespace(uri="file:///tmp/report.pdf")
assert namespace["_command_eve_prompt_has_attachment"]([]) is False
assert namespace["_command_eve_prompt_has_attachment"]([resource]) is True

agent = AIAgent()
agent._command_eve_current_turn_has_attachment = False
assert agent._spawn_background_review(["text"], review_memory=True) == "spawned"
assert review_calls[-1]["review_memory"] is True

agent._command_eve_current_turn_has_attachment = True
before = len(review_calls)
assert agent._spawn_background_review(["attachment"], review_memory=True) is None
assert len(review_calls) == before

assert agent._spawn_background_review(
    ["attachment"], review_memory=True, review_skills=True
) == "spawned"
assert review_calls[-1]["review_memory"] is False
assert review_calls[-1]["review_skills"] is True

print(
    json.dumps(
        {
            "text_memory_allowed": True,
            "attachment_memory_blocked": True,
            "attachment_skill_review_allowed": True,
            "ledger": sorted(namespace["_COMMAND_EVE_INSTALLED_PATCHES"]),
        }
    )
)
