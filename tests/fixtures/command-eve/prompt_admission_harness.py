#!/usr/bin/env python3
"""Provider-free behavioral proof for the Hermes ACP prompt-admission seam."""

from __future__ import annotations

import ast
import asyncio
import json
import sys
import time
import types
from pathlib import Path
from typing import Any


PROVIDER_PATH = Path(sys.argv[1]).resolve()
SOURCE = PROVIDER_PATH.read_text(encoding="utf-8")


def load_selected_symbols() -> dict[str, object]:
    tree = ast.parse(SOURCE, filename=str(PROVIDER_PATH))
    wanted_functions = {
        "_command_eve_mark_patch",
        "_command_eve_claim_quarantine_meta_key",
        "_command_eve_bind_claim_quarantine_db",
        "_command_eve_persist_claim_quarantine",
        "_command_eve_set_turn_memory_quarantine",
        "_install_command_eve_prompt_admission_patch",
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
    namespace: dict[str, object] = {"Any": Any, "asyncio": asyncio, "json": json, "time": time}
    exec(compile(module, str(PROVIDER_PATH), "exec"), namespace)
    return namespace


class FakeSessionDB:
    def __init__(self) -> None:
        self.meta: dict[str, str] = {}

    def get_meta(self, key: str) -> str | None:
        return self.meta.get(key)

    def set_meta(self, key: str, value: str) -> None:
        self.meta[key] = value


provider_calls: list[str] = []
admission_observations: list[dict[str, Any]] = []


class AIAgent:
    def __init__(self, session_id: str, db: FakeSessionDB) -> None:
        self.session_id = session_id
        self._session_db = db

    def run_conversation(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        del args
        provider_calls.append(str(kwargs.get("task_id") or ""))
        return {"final_response": "stubbed", "messages": []}


class FakeState:
    def __init__(self, agent: AIAgent) -> None:
        self.agent = agent
        self.is_running = False


class FakeSessionManager:
    def __init__(self, state: FakeState, db: FakeSessionDB) -> None:
        self.state = state
        self.db = db

    def get_session(self, _session_id: str) -> FakeState:
        return self.state

    def _get_db(self) -> FakeSessionDB:
        return self.db


class FakeConnection:
    def __init__(self, state: FakeState) -> None:
        self.state = state
        self.reject_phase: str | None = None

    async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, str]:
        admission_observations.append(
            {
                "method": method,
                "is_running": self.state.is_running,
                "provider_calls_before_ack": len(provider_calls),
                "params": dict(params),
            }
        )
        return {
            "version": "command-eve-prompt-admission/v1",
            "request_id": str(params["request_id"]),
            "status": "rejected" if params.get("phase") == self.reject_phase else "accepted",
        }


class HermesACPAgent:
    def __init__(self, state: FakeState, db: FakeSessionDB) -> None:
        self.session_manager = FakeSessionManager(state, db)
        self._conn = FakeConnection(state)

    async def prompt(self, prompt: list[Any], session_id: str, **_kwargs: Any) -> dict[str, Any]:
        self.session_manager.state.is_running = True
        try:
            return await asyncio.to_thread(
                self.session_manager.state.agent.run_conversation,
                user_message=prompt,
                task_id=session_id,
            )
        finally:
            self.session_manager.state.is_running = False


acp_adapter = types.ModuleType("acp_adapter")
acp_server = types.ModuleType("acp_adapter.server")
acp_server.HermesACPAgent = HermesACPAgent
acp_adapter.server = acp_server
sys.modules["acp_adapter"] = acp_adapter
sys.modules["acp_adapter.server"] = acp_server
run_agent = types.ModuleType("run_agent")
run_agent.AIAgent = AIAgent
sys.modules["run_agent"] = run_agent

namespace = load_selected_symbols()
namespace["_install_command_eve_prompt_admission_patch"]()
namespace["_install_command_eve_prompt_admission_patch"]()


def admission(request_id: str, turn_id: str, digest: str = "a" * 64) -> dict[str, str]:
    return {
        "version": "command-eve-prompt-admission/v1",
        "request_id": request_id,
        "turn_id": turn_id,
        "receipt_sha256": digest,
    }


async def main() -> None:
    db = FakeSessionDB()
    inner_agent = AIAgent("session-1", db)
    state = FakeState(inner_agent)
    acp_agent = HermesACPAgent(state, db)

    await acp_agent.prompt(
        ["verified sidecar text"],
        "session-1",
        commandEvePromptAdmission=admission("request-1", "turn-1"),
    )
    assert len(provider_calls) == 1
    assert [item["params"]["phase"] for item in admission_observations[-3:]] == ["accept", "commit", "finalize"]
    assert all(item["method"] == "command_eve/prompt_admission" for item in admission_observations[-3:])
    assert all(item["is_running"] is True for item in admission_observations[-3:])
    assert all(item["provider_calls_before_ack"] == 0 for item in admission_observations[-3:])
    assert all(item["params"]["session_id"] == "session-1" for item in admission_observations[-3:])
    assert not db.meta, "verified attachments use a transient gate, not durable false-claim quarantine"

    acp_agent._conn.reject_phase = "accept"
    try:
        await acp_agent.prompt(
            ["must not reach provider"],
            "session-1",
            commandEvePromptAdmission=admission("request-2", "turn-2", "b" * 64),
        )
    except RuntimeError as exc:
        assert "admission accept rejected" in str(exc)
    else:
        raise AssertionError("rejected admission reached the provider")
    assert len(provider_calls) == 1

    acp_agent._conn.reject_phase = "commit"
    try:
        await acp_agent.prompt(
            ["accepted but not committed"],
            "session-1",
            commandEvePromptAdmission=admission("request-commit", "turn-commit", "c" * 64),
        )
    except RuntimeError as exc:
        assert "commit rejected" in str(exc)
    else:
        raise AssertionError("uncommitted admission reached the provider")
    assert len(provider_calls) == 1
    acp_agent._conn.reject_phase = None

    acp_agent._conn.reject_phase = "finalize"
    try:
        await acp_agent.prompt(
            ["peer acknowledged but not finalized"],
            "session-1",
            commandEvePromptAdmission=admission("request-finalize", "turn-finalize", "d" * 64),
        )
    except RuntimeError as exc:
        assert "finalize rejected" in str(exc)
    else:
        raise AssertionError("unfinalized admission reached the provider")
    assert len(provider_calls) == 1
    acp_agent._conn.reject_phase = None

    try:
        await acp_agent.prompt(
            ["invalid receipt"],
            "session-1",
            commandEvePromptAdmission=admission("request-3", "turn-3", "INVALID"),
        )
    except ValueError as exc:
        assert "digest rejected" in str(exc)
    else:
        raise AssertionError("invalid admission metadata was accepted")
    assert len(provider_calls) == 1

    await acp_agent.prompt(["ordinary text"], "session-1")
    assert len(provider_calls) == 2

    print(
        json.dumps(
            {
                "admission_after_native_running_state": True,
                "provider_blocked_until_peer_finalize": True,
                "rejected_admission_blocks_provider": True,
                "rejected_commit_blocks_provider": True,
                "rejected_finalize_blocks_provider": True,
                "invalid_metadata_fails_closed": True,
                "ordinary_text_path_preserved": True,
                "verified_attachment_uses_transient_quarantine": True,
                "ledger": sorted(namespace["_COMMAND_EVE_INSTALLED_PATCHES"]),
            }
        )
    )


asyncio.run(main())
