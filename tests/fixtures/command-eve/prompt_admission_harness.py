#!/usr/bin/env python3
"""Provider-free proof against the exact bundled Hermes 0.20 wheel classes."""

from __future__ import annotations

import ast
import asyncio
import json
import os
import re
import subprocess
import sys
import threading
import time
import types
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any


PROVIDER_PATH = Path(sys.argv[1]).resolve()
WHEEL_PATH = Path(sys.argv[2]).resolve()
SOURCE = PROVIDER_PATH.read_text(encoding="utf-8")


def run_with_command_eve_python() -> None:
    if os.environ.get("COMMAND_EVE_REAL_WHEEL_CHILD") == "1":
        return
    configured = os.environ.get("COMMAND_EVE_HERMES_TEST_PYTHON", "").strip()
    installed = (
        Path.home()
        / "Library/Application Support/Command EVE/command-eve/command-eve-runtime/hermes/venv/bin/python3"
    )
    python = Path(configured) if configured else installed if installed.is_file() else Path(sys.executable)
    env = dict(os.environ)
    env["COMMAND_EVE_REAL_WHEEL_CHILD"] = "1"
    result = subprocess.run(
        [str(python), str(Path(__file__).resolve()), str(PROVIDER_PATH), str(WHEEL_PATH)],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    raise SystemExit(result.returncode)


run_with_command_eve_python()


def load_selected_symbols() -> dict[str, object]:
    tree = ast.parse(SOURCE, filename=str(PROVIDER_PATH))
    wanted_functions = {
        "_command_eve_mark_patch",
        "_command_eve_claim_quarantine_meta_key",
        "_command_eve_bind_claim_quarantine_db",
        "_command_eve_claim_quarantine_record_active",
        "_command_eve_persist_claim_quarantine",
        "_command_eve_persist_attachment_quarantine",
        "_command_eve_verify_attachment_quarantine",
        "_command_eve_set_turn_memory_quarantine",
        "_command_eve_turn_memory_quarantined",
        "_command_eve_prompt_text",
        "_command_eve_prompt_is_correction",
        "_install_command_eve_prompt_admission_patch",
        "_require_command_eve_prompt_admission_patch",
    }
    wanted_globals = {
        "_COMMAND_EVE_INSTALLED_PATCHES",
        "_COMMAND_EVE_MEMORY_QUARANTINE_BY_SESSION",
        "_COMMAND_EVE_QUARANTINE_DB_BY_SESSION",
        "_COMMAND_EVE_CLAIM_QUARANTINE_VERSION",
        "_COMMAND_EVE_CLAIM_QUARANTINE_META_PREFIX",
        "_COMMAND_EVE_SESSION_CWD",
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
    namespace: dict[str, object] = {
        "Any": Any,
        "asyncio": asyncio,
        "json": json,
        "re": re,
        "time": time,
    }
    exec(compile(module, str(PROVIDER_PATH), "exec"), namespace)
    return namespace


def closure_contains(function: Any, expected: Any) -> bool:
    return any(cell.cell_contents is expected for cell in (getattr(function, "__closure__", None) or ()))


def admission(request_id: str, turn_id: str, digest: str) -> dict[str, str]:
    return {
        "version": "command-eve-prompt-admission/v1",
        "request_id": request_id,
        "turn_id": turn_id,
        "receipt_sha256": digest,
    }


with TemporaryDirectory(prefix="command-eve-real-wheel-") as wheel_root, TemporaryDirectory(
    prefix="command-eve-admission-db-"
) as state_root:
    with zipfile.ZipFile(WHEEL_PATH) as wheel:
        wheel.extractall(wheel_root)
    sys.path.insert(0, wheel_root)

    from acp.schema import TextContentBlock  # type: ignore[import-not-found]  # noqa: E402
    from acp_adapter.server import HermesACPAgent  # type: ignore[import-not-found]  # noqa: E402
    from hermes_state import SessionDB  # type: ignore[import-not-found]  # noqa: E402
    from run_agent import AIAgent  # type: ignore[import-not-found]  # noqa: E402
    from agent import conversation_loop  # type: ignore[import-not-found]  # noqa: E402

    assert Path(sys.modules["acp_adapter.server"].__file__).is_relative_to(Path(wheel_root))
    assert Path(sys.modules["run_agent"].__file__).is_relative_to(Path(wheel_root))
    original_prompt = HermesACPAgent.prompt
    original_run = AIAgent.run_conversation
    original_loop = conversation_loop.run_conversation

    namespace = load_selected_symbols()
    namespace["_install_command_eve_prompt_admission_patch"]()
    namespace["_install_command_eve_prompt_admission_patch"]()
    namespace["_require_command_eve_prompt_admission_patch"]()
    original_prompt_impl = HermesACPAgent._prompt_impl
    assert closure_contains(original_prompt_impl, original_prompt)
    assert getattr(HermesACPAgent.prompt, "_command_eve_prompt_admission", False) is True
    assert closure_contains(AIAgent.run_conversation, original_run)

    provider_calls: list[str] = []

    def provider_stub(_agent: Any, _user_message: Any, *_args: Any, **_kwargs: Any) -> dict[str, Any]:
        provider_calls.append("provider")
        return {"final_response": "stubbed", "messages": []}

    conversation_loop.run_conversation = provider_stub

    class AgentProxy:
        def __init__(self) -> None:
            self.redirect_calls: list[str] = []
            self.model_inputs: list[Any] = []

        def redirect(self, text: str) -> bool:
            self.redirect_calls.append(text)
            return True

        def run_conversation(self, *, user_message: Any, **_kwargs: Any) -> dict[str, Any]:
            self.model_inputs.append(user_message)
            return {"final_response": "", "messages": []}

    db_path = Path(state_root) / "state.db"
    db = SessionDB(db_path)
    agent = AgentProxy()
    agent.session_id = "session-1"
    agent.platform = "acp"
    agent.model = "stubbed-local"
    agent._parent_session_id = None
    agent._session_db = db
    agent._conversation_root_id = lambda: "session-1"
    agent._reset_activity_labels_after_turn = lambda: None
    agent._command_eve_current_turn_has_attachment = False
    agent._command_eve_current_turn_has_correction = False
    agent._supports_active_turn_redirect = True

    class State:
        def __init__(self) -> None:
            self.session_id = "session-1"
            self.agent = agent
            self.cwd = "."
            self.history: list[dict[str, Any]] = []
            self.cancel_event = threading.Event()
            self.is_running = False
            self.queued_prompts: list[str] = []
            self.current_prompt_text = ""
            self.interrupted_prompt_text = ""
            self.pending_correction_text = ""
            self.cancel_epoch = 0
            self.pending_correction_cancel_epoch = 0
            self.runtime_lock = threading.RLock()

    state = State()

    class Manager:
        current_db: Any = db

        def get_session(self, session_id: str) -> State | None:
            return state if session_id == "session-1" else None

        def _get_db(self) -> Any:
            return self.current_db

        def save_session(self, _session_id: str) -> None:
            return None

    observations: list[dict[str, Any]] = []
    session_updates: list[Any] = []

    class Connection:
        reject_phase: str | None = None

        async def session_update(self, session_id: str, update: Any) -> None:
            assert session_id == "session-1"
            session_updates.append(update)

        async def ext_method(self, method: str, params: dict[str, Any]) -> dict[str, str]:
            observations.append(
                {
                    "method": method,
                    "phase": params["phase"],
                    "provider_calls_before_ack": len(provider_calls),
                    "session_id": params["session_id"],
                }
            )
            return {
                "version": "command-eve-prompt-admission/v1",
                "request_id": params["request_id"],
                "status": "rejected" if params["phase"] == self.reject_phase else "accepted",
            }

    connection = Connection()
    acp_agent = object.__new__(HermesACPAgent)
    acp_agent.session_manager = Manager()
    acp_agent._conn = connection

    async def no_usage(_state: Any) -> None:
        return None

    acp_agent._send_usage_update = no_usage
    acp_agent._sync_terminal_approval_mode = lambda _state: None

    async def prompt_impl(_self: Any, prompt: list[Any], session_id: str, **_kwargs: Any) -> Any:
        state.is_running = True
        try:
            result = await asyncio.to_thread(
                AIAgent.run_conversation,
                agent,
                user_message=prompt,
                task_id=session_id,
            )
            return types.SimpleNamespace(stop_reason="end_turn", result=result)
        finally:
            state.is_running = False

    acp_agent._prompt_impl = types.MethodType(prompt_impl, acp_agent)

    async def exercise() -> None:
        global db
        verified = admission("request-ok", "turn-ok", "a" * 64)
        await acp_agent.prompt(
            [types.SimpleNamespace(text="verified sidecar")],
            "session-1",
            commandEvePromptAdmission=verified,
        )
        assert namespace["_COMMAND_EVE_SESSION_CWD"]["session-1"] == "."
        assert provider_calls == ["provider"]
        assert [item["phase"] for item in observations[-4:]] == ["accept", "commit", "finalize", "ack"]
        assert all(item["method"] == "command_eve/prompt_admission" for item in observations[-4:])
        assert all(item["provider_calls_before_ack"] == 0 for item in observations[-4:])
        assert all(item["session_id"] == "session-1" for item in observations[-4:])
        key = namespace["_command_eve_claim_quarantine_meta_key"]("session-1")
        verified_record = json.loads(db.get_meta(key))
        assert verified_record["status"] == "verified"
        assert namespace["_command_eve_turn_memory_quarantined"]("session-1") is False

        connection.reject_phase = "accept"
        try:
            await acp_agent.prompt(
                [types.SimpleNamespace(text="must remain unverified")],
                "session-1",
                commandEvePromptAdmission=admission("request-reject", "turn-reject", "b" * 64),
            )
        except RuntimeError as error:
            assert "admission accept rejected" in str(error)
        else:
            raise AssertionError("rejected admission reached the provider")
        assert provider_calls == ["provider"]
        active_record = json.loads(db.get_meta(key))
        assert active_record["status"] == "active"
        assert active_record["reason"] == "attachment_grounding_pending"

        connection.reject_phase = "ack"
        try:
            await acp_agent.prompt(
                [types.SimpleNamespace(text="must wait for peer ack")],
                "session-1",
                commandEvePromptAdmission=admission("request-ack-reject", "turn-ack-reject", "d" * 64),
            )
        except RuntimeError as error:
            assert "admission ack rejected" in str(error)
        else:
            raise AssertionError("rejected peer acknowledgement reached the provider")
        assert provider_calls == ["provider"]
        active_record = json.loads(db.get_meta(key))
        assert active_record["status"] == "active"
        assert active_record["reason"] == "attachment_grounding_pending"

        # Crash/restart must preserve the safety fence without permanently
        # bricking the session. A new exact turn/digest atomically replaces the
        # stale pending record while quarantine remains active until finalize.
        db.close()
        namespace["_COMMAND_EVE_MEMORY_QUARANTINE_BY_SESSION"].clear()
        namespace["_COMMAND_EVE_QUARANTINE_DB_BY_SESSION"].clear()
        db = SessionDB(db_path)
        agent._session_db = db
        acp_agent.session_manager.current_db = db
        namespace["_command_eve_bind_claim_quarantine_db"](agent, "session-1", db)
        assert namespace["_command_eve_turn_memory_quarantined"]("session-1") is True
        connection.reject_phase = None
        await acp_agent.prompt(
            [types.SimpleNamespace(text="verified retry sidecar")],
            "session-1",
            commandEvePromptAdmission=admission("request-retry", "turn-retry", "c" * 64),
        )
        assert provider_calls == ["provider", "provider"]
        retry_record = json.loads(db.get_meta(key))
        assert retry_record["status"] == "verified"
        assert retry_record["turn_id"] == "turn-retry"
        assert retry_record["evidence_digest"] == "c" * 64
        assert namespace["_command_eve_turn_memory_quarantined"]("session-1") is False

        # Now execute the public correction paths through the wheel's real
        # V22 prompt body, preserved behind the compatibility _prompt_impl seam.
        # These branches are exactly where Hermes 0.20 rewrites
        # idle /steer, refuses idle /correct, redirects or queues busy text,
        # and salvages post-cancel plain text.
        acp_agent._prompt_impl = types.MethodType(original_prompt_impl, acp_agent)
        acp_agent._conn = None
        state.is_running = False
        state.interrupted_prompt_text = ""
        state.queued_prompts.clear()
        before_models = len(agent.model_inputs)
        response = await acp_agent.prompt(
            [TextContentBlock(type="text", text="/correct stale correction")],
            "session-1",
        )
        assert response.stop_reason == "refusal"
        assert len(agent.model_inputs) == before_models
        correction_record = json.loads(db.get_meta(key))
        assert correction_record["status"] == "active"
        assert correction_record["reason"] == "user_correction"

        state.is_running = False
        state.interrupted_prompt_text = ""
        await acp_agent.prompt(
            [TextContentBlock(type="text", text="/steer idle guidance")],
            "session-1",
        )
        assert agent.model_inputs[-1] == "idle guidance"

        state.is_running = True
        state.queued_prompts.clear()
        redirect_count = len(agent.redirect_calls)
        model_count = len(agent.model_inputs)
        await acp_agent.prompt(
            [TextContentBlock(type="text", text="busy correction")],
            "session-1",
        )
        assert agent.redirect_calls[redirect_count:] == ["busy correction"]
        assert len(agent.model_inputs) == model_count

        state.is_running = True
        state.queued_prompts.clear()
        redirect_count = len(agent.redirect_calls)
        update_count = len(session_updates)
        acp_agent._conn = connection
        response = await acp_agent.prompt(
            [TextContentBlock(type="text", text="/correct authoritative fix")],
            "session-1",
        )
        assert response.stop_reason == "end_turn"
        assert agent.redirect_calls[redirect_count:] == ["authoritative fix"]
        assert state.queued_prompts == []
        correction_updates = session_updates[update_count:]
        assert len(correction_updates) == 2
        assert correction_updates[0].field_meta == {
            "command_eve_control": "authoritative_correction"
        }
        assert correction_updates[0].content.text == "authoritative fix"
        assert correction_updates[1].content.text.startswith(
            "Correction accepted for the active turn: authoritative fix"
        )

        def reject_redirect(text: str) -> bool:
            agent.redirect_calls.append(text)
            return False

        agent.redirect = reject_redirect
        state.is_running = True
        state.queued_prompts.clear()
        update_count = len(session_updates)
        response = await acp_agent.prompt(
            [TextContentBlock(type="text", text="/correct crossed terminal")],
            "session-1",
        )
        assert response.stop_reason == "refusal"
        assert state.queued_prompts == []
        assert len(session_updates) == update_count
        acp_agent._conn = None

        def broken_redirect(text: str) -> bool:
            agent.redirect_calls.append(text)
            raise RuntimeError("redirect unavailable")

        agent.redirect = broken_redirect
        state.is_running = True
        state.queued_prompts.clear()
        await acp_agent.prompt(
            [TextContentBlock(type="text", text="queued correction")],
            "session-1",
        )
        assert state.queued_prompts == ["queued correction"]

        class BrokenDB:
            def get_meta(self, meta_key: str) -> Any:
                return db.get_meta(meta_key)

            def set_meta(self, _meta_key: str, _value: str) -> None:
                raise RuntimeError("disk unavailable")

        manager = acp_agent.session_manager
        manager.current_db = BrokenDB()
        redirect_count = len(agent.redirect_calls)
        state.is_running = True
        try:
            await acp_agent.prompt(
                [TextContentBlock(type="text", text="must not be swallowed")],
                "session-1",
            )
        except RuntimeError as error:
            assert "quarantine persistence unavailable" in str(error)
        else:
            raise AssertionError("busy correction swallowed quarantine persistence failure")
        assert len(agent.redirect_calls) == redirect_count
        manager.current_db = db
        namespace["_command_eve_bind_claim_quarantine_db"](agent, "session-1", db)

        agent.redirect = types.MethodType(AgentProxy.redirect, agent)
        state.is_running = False
        state.queued_prompts.clear()
        state.interrupted_prompt_text = "cancelled original"
        await acp_agent.prompt(
            [TextContentBlock(type="text", text="plain correction after cancel")],
            "session-1",
        )
        assert agent.model_inputs[-1] == (
            "cancelled original\n\n"
            "User correction/guidance after interrupt: plain correction after cancel"
        )

        # The bootstrap must fail closed if the actual wheel seam loses either
        # marker after installation; a diagnostic-only success is insufficient.
        patched_run = AIAgent.run_conversation
        AIAgent.run_conversation = original_run
        try:
            namespace["_require_command_eve_prompt_admission_patch"]()
        except RuntimeError as error:
            assert "patch unavailable" in str(error)
        else:
            raise AssertionError("missing real-wheel run patch was accepted")
        finally:
            AIAgent.run_conversation = patched_run
        namespace["_require_command_eve_prompt_admission_patch"]()

    try:
        asyncio.run(exercise())
    finally:
        conversation_loop.run_conversation = original_loop

    db.close()
    namespace["_COMMAND_EVE_MEMORY_QUARANTINE_BY_SESSION"].clear()
    namespace["_COMMAND_EVE_QUARANTINE_DB_BY_SESSION"].clear()
    restarted_db = SessionDB(db_path)
    restarted_agent = AgentProxy()
    restarted_agent._session_db = restarted_db
    namespace["_command_eve_bind_claim_quarantine_db"](restarted_agent, "session-1", restarted_db)
    assert namespace["_command_eve_turn_memory_quarantined"]("session-1") is True
    restarted_db.close()

    print(
        json.dumps(
            {
                "exact_wheel_classes_loaded": True,
                "exact_wheel_prompt_executed": True,
                "exact_wheel_run_conversation_executed": True,
                "fail_closed_patch_required": True,
                "accept_commit_finalize_ack_ordered": True,
                "provider_blocked_until_peer_ack": True,
                "rejected_admission_blocks_provider": True,
                "verified_attachment_record_typed": True,
                "unverified_attachment_restart_quarantined": True,
                "stale_pending_restart_retry_succeeds": True,
                "real_wheel_idle_correction_quarantined": True,
                "real_wheel_idle_steer_quarantined": True,
                "real_wheel_busy_redirect_quarantined": True,
                "real_wheel_active_correct_authoritative": True,
                "real_wheel_active_correct_terminal_race_refused": True,
                "real_wheel_session_cwd_recorded": True,
                "real_wheel_queued_correction_quarantined": True,
                "real_wheel_post_cancel_correction_quarantined": True,
                "busy_redirect_persistence_failure_blocked": True,
                "ledger": sorted(namespace["_COMMAND_EVE_INSTALLED_PATCHES"]),
            }
        )
    )
