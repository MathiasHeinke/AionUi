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
        "_command_eve_set_turn_memory_quarantine",
        "_command_eve_turn_memory_quarantined",
        "_command_eve_enter_turn_memory_quarantine",
        "_command_eve_exit_turn_memory_quarantine",
        "_install_command_eve_attachment_memory_gate",
        "_command_eve_authority_pre_tool_call",
    }
    wanted_globals = {
        "_COMMAND_EVE_INSTALLED_PATCHES",
        "_COMMAND_EVE_MEMORY_QUARANTINE_BY_SESSION",
    }
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
sync_calls: list[dict[str, object]] = []


class AIAgent:
    def _sync_external_memory_for_turn(self, **kwargs: Any):
        sync_calls.append(kwargs)
        return "synced"

    def steer(self, text: str) -> bool:
        return bool(text.strip())

    def redirect(self, text: str) -> bool:
        return bool(text.strip())

    def interrupt(self, message: str | None = None, *, hard_cancel: bool = False) -> None:
        del message, hard_cancel

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
namespace["_COMMAND_EVE_NATIVE_AUTHORITY_TOOLS"] = {
    "terminal",
    "read_file",
    "write_file",
    "patch",
    "search_files",
}
namespace["_command_eve_ask_tool_authority"] = lambda _tool, _action="": {
    "decision": "allow",
    "ladder": 5,
}
namespace["_install_command_eve_attachment_memory_gate"]()
namespace["_install_command_eve_attachment_memory_gate"]()

resource = types.SimpleNamespace(uri="file:///tmp/report.pdf")
assert namespace["_command_eve_prompt_has_attachment"]([]) is False
assert namespace["_command_eve_prompt_has_attachment"]([resource]) is True

attachment_agent = AIAgent()
attachment_agent._command_eve_current_turn_has_attachment = False
attachment_agent._command_eve_current_turn_has_correction = False
namespace["_command_eve_enter_turn_memory_quarantine"](
    attachment_agent, "session-attachment", [resource]
)
namespace["_command_eve_enter_turn_memory_quarantine"](
    attachment_agent, "session-attachment", []
)
assert attachment_agent._command_eve_prompt_depth == 2
assert attachment_agent._command_eve_current_turn_has_attachment is True
assert namespace["_command_eve_turn_memory_quarantined"]("session-attachment") is True
namespace["_command_eve_exit_turn_memory_quarantine"](
    attachment_agent, "session-attachment"
)
assert namespace["_command_eve_turn_memory_quarantined"]("session-attachment") is True
namespace["_command_eve_exit_turn_memory_quarantine"](
    attachment_agent, "session-attachment"
)
assert namespace["_command_eve_turn_memory_quarantined"]("session-attachment") is False

agent = AIAgent()
agent._command_eve_session_id = "session-1"
agent._command_eve_current_turn_has_attachment = False
agent._command_eve_current_turn_has_correction = False
namespace["_command_eve_set_turn_memory_quarantine"]("session-1", False)
assert agent._spawn_background_review(["text"], review_memory=True) == "spawned"
assert review_calls[-1]["review_memory"] is True
assert agent._sync_external_memory_for_turn(turn="text") == "synced"
assert (
    namespace["_command_eve_authority_pre_tool_call"](
        tool_name="memory",
        args={"operations": [{"action": "add", "content": "verified"}]},
        session_id="session-1",
    )
    is None
)

agent._command_eve_current_turn_has_attachment = True
namespace["_command_eve_set_turn_memory_quarantine"]("session-1", True)
before = len(review_calls)
assert agent._spawn_background_review(["attachment"], review_memory=True) is None
assert len(review_calls) == before

assert agent._spawn_background_review(["attachment"], review_memory=True, review_skills=True) is None
assert len(review_calls) == before
assert agent._sync_external_memory_for_turn(turn="attachment") is None
assert len(sync_calls) == 1
assert namespace["_command_eve_authority_pre_tool_call"](
    tool_name="memory",
    args={"operations": [{"action": "add", "content": "unverified"}]},
    session_id="session-1",
)["action"] == "block"
assert namespace["_command_eve_authority_pre_tool_call"](
    tool_name="skill_manage",
    args={"action": "patch", "name": "learned-from-unverified-input"},
    session_id="session-1",
)["action"] == "block"

agent._command_eve_current_turn_has_attachment = False
namespace["_command_eve_set_turn_memory_quarantine"]("session-1", False)
namespace["_command_eve_enter_turn_memory_quarantine"](agent, "session-1", [])
assert agent.interrupt("please correct that") is None
assert agent._command_eve_current_turn_has_correction is True
assert namespace["_command_eve_turn_memory_quarantined"]("session-1") is True
# Hermes 0.20 starts the accepted /correct payload through a nested _prompt_impl.
# Entering that text-only turn must preserve, not reset, the outer correction gate.
namespace["_command_eve_enter_turn_memory_quarantine"](agent, "session-1", [])
assert agent._command_eve_prompt_depth == 2
assert agent._command_eve_current_turn_has_correction is True
assert namespace["_command_eve_turn_memory_quarantined"]("session-1") is True
before = len(review_calls)
assert agent._spawn_background_review(["corrected"], review_memory=True, review_skills=True) is None
assert len(review_calls) == before
assert agent._sync_external_memory_for_turn(turn="corrected") is None
assert len(sync_calls) == 1
namespace["_command_eve_exit_turn_memory_quarantine"](agent, "session-1")
assert agent._command_eve_prompt_depth == 1
assert namespace["_command_eve_turn_memory_quarantined"]("session-1") is True
namespace["_command_eve_exit_turn_memory_quarantine"](agent, "session-1")
assert agent._command_eve_prompt_depth == 0
assert namespace["_command_eve_turn_memory_quarantined"]("session-1") is False

print(
    json.dumps(
        {
            "text_memory_allowed": True,
            "attachment_memory_blocked": True,
            "attachment_skill_review_blocked": True,
            "attachment_external_sync_blocked": True,
            "correction_memory_and_skill_blocked": True,
            "direct_memory_and_skill_writes_blocked": True,
            "acp_interrupt_correction_blocked": True,
            "recursive_correction_turn_blocked": True,
            "nested_attachment_turn_blocked": True,
            "ledger": sorted(namespace["_COMMAND_EVE_INSTALLED_PATCHES"]),
        }
    )
)
