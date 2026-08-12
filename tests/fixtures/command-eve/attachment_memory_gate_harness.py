#!/usr/bin/env python3
"""Behavioral gate for the narrow per-turn attachment memory rule."""

from __future__ import annotations

import ast
import json
import sys
import time
import types
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any


PROVIDER_PATH = Path(sys.argv[1]).resolve()
WHEEL_PATH = Path(sys.argv[2]).resolve()
SOURCE = PROVIDER_PATH.read_text(encoding="utf-8")
sys.path.insert(0, str(WHEEL_PATH))
from hermes_state import SessionDB  # type: ignore[import-not-found]  # noqa: E402


def load_selected_symbols() -> dict[str, object]:
    tree = ast.parse(SOURCE, filename=str(PROVIDER_PATH))
    wanted_functions = {
        "_command_eve_mark_patch",
        "_command_eve_prompt_has_attachment",
        "_command_eve_claim_quarantine_meta_key",
        "_command_eve_bind_claim_quarantine_db",
        "_command_eve_claim_quarantine_record_active",
        "_command_eve_persist_claim_quarantine",
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
        "_COMMAND_EVE_QUARANTINE_DB_BY_SESSION",
        "_COMMAND_EVE_CLAIM_QUARANTINE_VERSION",
        "_COMMAND_EVE_CLAIM_QUARANTINE_META_PREFIX",
    }
    body: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted_functions:
            body.append(node)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.target.id in wanted_globals:
                body.append(node)
        elif isinstance(node, ast.Assign):
            names = [target.id for target in node.targets if isinstance(target, ast.Name)]
            if any(name in wanted_globals for name in names):
                body.append(node)
    module = ast.fix_missing_locations(ast.Module(body=body, type_ignores=[]))
    namespace: dict[str, object] = {"Any": Any, "json": json, "time": time}
    exec(compile(module, str(PROVIDER_PATH), "exec"), namespace)
    return namespace


review_calls: list[dict[str, object]] = []
sync_calls: list[dict[str, object]] = []
boundary_calls: list[str] = []


class AIAgent:
    def commit_memory_session(self, messages: Any = None):
        del messages
        boundary_calls.append("commit")
        return "committed"

    def shutdown_memory_provider(self, messages: Any = None):
        del messages
        boundary_calls.append("shutdown")
        return "shutdown"

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


class HermesACPAgent:
    def _cmd_reset(self, args: str, state: Any) -> str:
        state.history.clear()
        if args == "fail":
            return "Conversation history cleared. Agent session state reset failed; see logs."
        return "Conversation history cleared."


run_agent = types.ModuleType("run_agent")
run_agent.AIAgent = AIAgent
sys.modules["run_agent"] = run_agent
acp_adapter = types.ModuleType("acp_adapter")
acp_server = types.ModuleType("acp_adapter.server")
acp_server.HermesACPAgent = HermesACPAgent
acp_adapter.server = acp_server
sys.modules["acp_adapter"] = acp_adapter
sys.modules["acp_adapter.server"] = acp_server

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
temp_dir = TemporaryDirectory(prefix="command-eve-claim-quarantine-")
db_path = Path(temp_dir.name) / "state.db"
db = SessionDB(db_path)

resource = types.SimpleNamespace(uri="file:///tmp/report.pdf")
assert namespace["_command_eve_prompt_has_attachment"]([]) is False
assert namespace["_command_eve_prompt_has_attachment"]([resource]) is True

attachment_agent = AIAgent()
attachment_agent._session_db = db
attachment_agent._command_eve_current_turn_has_attachment = False
attachment_agent._command_eve_current_turn_has_correction = False
namespace["_command_eve_bind_claim_quarantine_db"](attachment_agent, "session-attachment", db)
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
agent._session_db = db
agent._command_eve_session_id = "session-1"
agent._command_eve_current_turn_has_attachment = False
agent._command_eve_current_turn_has_correction = False
namespace["_command_eve_set_turn_memory_quarantine"]("session-1", False)
namespace["_command_eve_bind_claim_quarantine_db"](agent, "session-1", db)
assert agent._spawn_background_review(["text"], review_memory=True) == "spawned"
assert review_calls[-1]["review_memory"] is True
assert agent._sync_external_memory_for_turn(turn="text") == "synced"
assert agent.commit_memory_session(["text"]) == "committed"
assert agent.shutdown_memory_provider(["text"]) == "shutdown"
assert boundary_calls == ["commit", "shutdown"]
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
assert agent.commit_memory_session(["attachment"]) is None
assert agent.shutdown_memory_provider(["attachment"]) is None
assert boundary_calls == ["commit", "shutdown"]
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
assert namespace["_command_eve_turn_memory_quarantined"]("session-1") is True

# Crash/restart proof: volatile process state disappears, but Hermes' native
# state_meta record keeps all three self-improvement lanes fail-closed.
db.close()
namespace["_COMMAND_EVE_MEMORY_QUARANTINE_BY_SESSION"].clear()
namespace["_COMMAND_EVE_QUARANTINE_DB_BY_SESSION"].clear()
restarted_db = SessionDB(db_path)
restarted_agent = AIAgent()
restarted_agent._session_db = restarted_db
restarted_agent._command_eve_session_id = "session-1"
restarted_agent._command_eve_current_turn_has_attachment = False
restarted_agent._command_eve_current_turn_has_correction = False
namespace["_command_eve_bind_claim_quarantine_db"](restarted_agent, "session-1", restarted_db)
assert namespace["_command_eve_turn_memory_quarantined"]("session-1") is True
before = len(review_calls)
assert restarted_agent._spawn_background_review(["after crash"], review_memory=True, review_skills=True) is None
assert len(review_calls) == before
assert restarted_agent._sync_external_memory_for_turn(turn="after crash") is None
assert restarted_agent.commit_memory_session(["after crash"]) is None
assert restarted_agent.shutdown_memory_provider(["after crash"]) is None
assert boundary_calls == ["commit", "shutdown"]
assert namespace["_command_eve_authority_pre_tool_call"](
    tool_name="memory",
    args={"operations": [{"action": "add", "content": "stale claim"}]},
    session_id="session-1",
)["action"] == "block"
quarantine_key = namespace["_command_eve_claim_quarantine_meta_key"]("session-1")
active_record = json.loads(restarted_db.get_meta(quarantine_key))
assert active_record["status"] == "active"
assert namespace["_command_eve_turn_memory_quarantined"]("session-1") is True
reset_state = types.SimpleNamespace(
    session_id="session-1",
    agent=restarted_agent,
    history=[{"role": "assistant", "content": "false claim"}],
)
assert HermesACPAgent()._cmd_reset("fail", reset_state).endswith("reset failed; see logs.")
assert reset_state.history == []
assert namespace["_command_eve_turn_memory_quarantined"]("session-1") is True
reset_state.history.append({"role": "assistant", "content": "false claim"})
assert HermesACPAgent()._cmd_reset("", reset_state) == "Conversation history cleared."
assert reset_state.history == []
assert namespace["_command_eve_turn_memory_quarantined"]("session-1") is True
assert json.loads(restarted_db.get_meta(quarantine_key))["status"] == "active"
restarted_db.close()
temp_dir.cleanup()

print(
    json.dumps(
        {
            "text_memory_allowed": True,
            "attachment_memory_blocked": True,
            "attachment_skill_review_blocked": True,
            "attachment_external_sync_blocked": True,
            "compression_and_session_end_memory_blocked": True,
            "correction_memory_and_skill_blocked": True,
            "direct_memory_and_skill_writes_blocked": True,
            "acp_interrupt_correction_blocked": True,
            "recursive_correction_turn_blocked": True,
            "nested_attachment_turn_blocked": True,
            "crash_restart_quarantine_blocked": True,
            "native_session_db_restart_quarantine": True,
            "automatic_end_turn_cannot_reconcile": True,
            "session_reset_keeps_durable_quarantine": True,
            "ledger": sorted(namespace["_COMMAND_EVE_INSTALLED_PATCHES"]),
        }
    )
)
