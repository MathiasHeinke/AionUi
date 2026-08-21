#!/usr/bin/env python3
"""Prove that overlapping native clarify calls keep turn-local ownership.

The emitted provider override is the production compatibility seam. This
harness extracts its real bind/callback/unbind functions, replaces only the ACP
wire with deterministic in-process stubs, and overlaps two prompts for the same
session and shared agent. It must keep each native clarify callback bound to its
own active turn and restore the previous callback in the right order.
"""

from __future__ import annotations

import ast
import asyncio
import contextvars
import json
import logging
import sys
import threading
import types
import uuid
from pathlib import Path
from typing import Any


PROVIDER_PATH = Path(sys.argv[1]).resolve()
SOURCE = PROVIDER_PATH.read_text(encoding="utf-8")
SESSION_KEY: contextvars.ContextVar[str] = contextvars.ContextVar(
    "command_eve_test_session_key", default=""
)


def install_module(name: str, module: types.ModuleType) -> None:
    sys.modules[name] = module
    parent_name, _, child_name = name.rpartition(".")
    if parent_name:
        parent = sys.modules.get(parent_name)
        if parent is not None:
            setattr(parent, child_name, module)


class AllowedOutcome:
    def __init__(self, option_id: str) -> None:
        self.option_id = option_id


class PermissionOption:
    def __init__(self, **kwargs: Any) -> None:
        self.__dict__.update(kwargs)


def update_tool_call(call_id: str, **kwargs: Any) -> dict[str, Any]:
    return {"call_id": call_id, **kwargs}


def tool_content(value: Any) -> Any:
    return value


def text_block(value: str) -> dict[str, str]:
    return {"text": value}


def safe_schedule_threadsafe(
    coroutine: Any,
    loop: asyncio.AbstractEventLoop,
    **_kwargs: Any,
) -> Any:
    return asyncio.run_coroutine_threadsafe(coroutine, loop)


def get_session_env(name: str, default: str = "") -> str:
    if name == "HERMES_SESSION_KEY":
        return SESSION_KEY.get()
    return default


acp_module = types.ModuleType("acp")
acp_module.__path__ = []  # type: ignore[attr-defined]
acp_module.update_tool_call = update_tool_call  # type: ignore[attr-defined]
acp_module.tool_content = tool_content  # type: ignore[attr-defined]
acp_module.text_block = text_block  # type: ignore[attr-defined]
install_module("acp", acp_module)
acp_schema_module = types.ModuleType("acp.schema")
acp_schema_module.AllowedOutcome = AllowedOutcome  # type: ignore[attr-defined]
acp_schema_module.PermissionOption = PermissionOption  # type: ignore[attr-defined]
install_module("acp.schema", acp_schema_module)

agent_module = types.ModuleType("agent")
agent_module.__path__ = []  # type: ignore[attr-defined]
install_module("agent", agent_module)
agent_async_utils_module = types.ModuleType("agent.async_utils")
agent_async_utils_module.safe_schedule_threadsafe = safe_schedule_threadsafe  # type: ignore[attr-defined]
install_module("agent.async_utils", agent_async_utils_module)

gateway_module = types.ModuleType("gateway")
gateway_module.__path__ = []  # type: ignore[attr-defined]
install_module("gateway", gateway_module)
gateway_session_module = types.ModuleType("gateway.session_context")
gateway_session_module.get_session_env = get_session_env  # type: ignore[attr-defined]
install_module("gateway.session_context", gateway_session_module)


def load_patch() -> dict[str, Any]:
    tree = ast.parse(SOURCE, filename=str(PROVIDER_PATH))
    wanted_functions = {
        "_command_eve_acp_clarify_callback",
        "_command_eve_bind_acp_clarify",
        "_command_eve_unbind_acp_clarify",
    }
    wanted_classes: set[str] = set()
    wanted_globals = {
        "_COMMAND_EVE_ACP_CLARIFY_TIMEOUT_SECONDS",
        "_COMMAND_EVE_ACP_CLARIFY_LOCK",
        "_COMMAND_EVE_ACP_CLARIFY_CONTEXT",
        "_COMMAND_EVE_ACP_CLARIFY_AGENTS",
    }
    body: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in wanted_functions:
            body.append(node)
        elif isinstance(node, ast.ClassDef) and node.name in wanted_classes:
            body.append(node)
        elif isinstance(node, ast.Assign) and {
            target.id for target in node.targets if isinstance(target, ast.Name)
        } & wanted_globals:
            body.append(node)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            if node.target.id in wanted_globals:
                body.append(node)

    namespace: dict[str, Any] = {
        "Any": Any,
        "ContextVar": contextvars.ContextVar,
        "json": json,
        "logging": logging,
        "threading": threading,
        "uuid": uuid,
    }
    exec(
        compile(ast.fix_missing_locations(ast.Module(body=body, type_ignores=[])), str(PROVIDER_PATH), "exec"),
        namespace,
    )
    missing = wanted_functions - set(namespace)
    missing.update(wanted_classes - set(namespace))
    if missing:
        raise SystemExit(f"emitted override is missing clarify symbols: {sorted(missing)}")
    return namespace


NS = load_patch()


class Agent:
    def __init__(self) -> None:
        self.clarify_callback: object = object()
        self.original_callback = self.clarify_callback


async def main() -> dict[str, bool]:
    agent = Agent()
    loop = asyncio.get_running_loop()
    b_bound = asyncio.Event()
    b_permission_seen = asyncio.Event()
    allow_b = asyncio.Event()
    a_finished = asyncio.Event()
    observed: list[dict[str, Any]] = []

    async def request_permission(
        *, session_id: str, tool_call: dict[str, Any], options: list[PermissionOption]
    ) -> types.SimpleNamespace:
        metadata = dict(tool_call["raw_input"]["metadata"])
        observed.append({"session_id": session_id, "metadata": metadata})
        if len(observed) == 1:
            b_permission_seen.set()
            await allow_b.wait()
        return types.SimpleNamespace(outcome=AllowedOutcome(options[0].option_id))

    async def invoke(is_b: bool) -> str:
        session_token = SESSION_KEY.set("same-session")
        owner = object()
        context_token = NS["_command_eve_bind_acp_clarify"](
            agent,
            "same-session",
            request_permission,
            loop,
            threading.get_ident(),
            owner,
        )
        try:
            if is_b:
                b_bound.set()
            else:
                await b_bound.wait()
                await b_permission_seen.wait()
            result = await asyncio.to_thread(
                NS["_command_eve_acp_clarify_callback"],
                "Use the selected option?",
                ["Use selected option"],
            )
            return str(result)
        finally:
            NS["_command_eve_unbind_acp_clarify"](agent, owner, context_token)
            SESSION_KEY.reset(session_token)
            if not is_b:
                a_finished.set()

    task_a = asyncio.create_task(invoke(False))
    task_b = asyncio.create_task(invoke(True))
    await b_permission_seen.wait()
    await a_finished.wait()
    first_cleanup_preserved_active_callback = agent.clarify_callback is NS[
        "_command_eve_acp_clarify_callback"
    ]
    allow_b.set()
    result_a, result_b = await asyncio.gather(task_a, task_b)

    isolated = len(observed) == 2 and all(
        item["metadata"]
        == {
            "interaction_kind": "clarify",
            "question": "Use the selected option?",
            "choices": ["Use selected option"],
        }
        for item in observed
    )

    no_context_fails_closed = False
    session_token = SESSION_KEY.set("same-session")
    try:
        try:
            await asyncio.to_thread(
                NS["_command_eve_acp_clarify_callback"],
                "Question?",
                ["Choice"],
            )
        except RuntimeError:
            no_context_fails_closed = True
    finally:
        SESSION_KEY.reset(session_token)

    return {
        "same_session_clarify_metadata_isolated": isolated,
        "both_callbacks_completed": "Use selected option" in result_a and "Use selected option" in result_b,
        "first_cleanup_preserves_active_owner": first_cleanup_preserved_active_callback,
        "final_cleanup_restores_original_callback": agent.clarify_callback is agent.original_callback,
        "owner_registry_cleared": not NS["_COMMAND_EVE_ACP_CLARIFY_AGENTS"],
        "cleared_context_fails_closed": no_context_fails_closed,
    }


print(json.dumps(asyncio.run(main()), sort_keys=True))
