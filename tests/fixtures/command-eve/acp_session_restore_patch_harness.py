"""Contract harness for the emitted Command EVE ACP session-restore patch.

Drives the REAL emitted python (selected AST nodes from the generated provider
override) against fake acp_adapter/hermes_cli/hermes_state modules and proves
the restore contract:

  A->B re-point (persisted loopback A, current runtime B), session_id/history
  kwargs preserved, model_config persisted back with B; remote persisted
  untouched; non-'custom' provider untouched; current runtime missing or
  non-loopback => fail closed (byte-identical wheel behaviour); the current
  runtime's base_url (and with it the current boot credential pairing) always
  wins over anything persisted.
"""

from __future__ import annotations

import ast
import json
import sys
import types
from pathlib import Path

PORT_A = 41111
PORT_B = 42222
BASE_A = f"http://127.0.0.1:{PORT_A}/v1"
BASE_B = f"http://127.0.0.1:{PORT_B}/v1"
REMOTE_BASE = "https://api.openrouter.ai/v1"

OVERRIDE_PATH = Path(sys.argv[1]).resolve()
SOURCE = OVERRIDE_PATH.read_text(encoding="utf-8")


def load_restore_symbols() -> dict[str, object]:
    tree = ast.parse(SOURCE, filename=str(OVERRIDE_PATH))
    selected = {
        "_command_eve_is_local_shim_base",
        "_command_eve_is_loopback_http_host",
        "_command_eve_current_loopback_custom_base_url",
        "_command_eve_resolve_restore_base_url",
        "_command_eve_persist_refreshed_session_base_url",
        "_install_command_eve_acp_session_restore_patch",
        # G1 (CEVE-18205): the installer records itself in the shim ledger.
        "_command_eve_mark_patch",
    }
    selected_globals = {"_COMMAND_EVE_EXPECTED_PATCHES", "_COMMAND_EVE_INSTALLED_PATCHES"}
    allowed_imports = {"json", "logging", "os", "re"}
    allowed_from = {"typing", "urllib.parse", "__future__"}
    body: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, ast.Import) and all(alias.name in allowed_imports for alias in node.names):
            body.append(node)
        elif isinstance(node, ast.ImportFrom) and node.module in allowed_from:
            body.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in selected:
            body.append(node)
        elif isinstance(node, ast.Assign) and {
            target.id for target in node.targets if isinstance(target, ast.Name)
        } & selected_globals:
            body.append(node)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id in selected_globals:
            # An ANNOTATED assignment is not an ast.Assign; without this branch the
            # ledger's backing set never entered the namespace and the installer
            # raised NameError at the marker call.
            body.append(node)
    module = ast.fix_missing_locations(ast.Module(body=body, type_ignores=[]))
    namespace: dict[str, object] = {}
    exec(compile(module, str(OVERRIDE_PATH), "exec"), namespace)
    missing = selected - set(namespace)
    if missing:
        raise SystemExit(f"emitted override is missing restore symbols: {sorted(missing)}")
    return namespace


NS = load_restore_symbols()


class FakeDB:
    def __init__(self, row: dict[str, object] | None):
        self.row = row
        self.meta_writes: list[tuple[str, str]] = []

    def get_session(self, session_id: str) -> dict[str, object] | None:
        return self.row

    def update_session_meta(self, session_id: str, model_config_json: str) -> None:
        self.meta_writes.append((session_id, model_config_json))


MAKE_AGENT_CALLS: list[dict[str, object]] = []


def fake_make_agent(self: object, *args: object, **kwargs: object) -> dict[str, object]:
    MAKE_AGENT_CALLS.append(dict(kwargs))
    return {"agent": True, "kwargs": dict(kwargs)}


def install_with(current_base_url: str, row: dict[str, object] | None) -> FakeDB:
    """Install the emitted patch against fakes; return the FakeDB for asserts."""
    db = FakeDB(row)

    runtime_provider = types.ModuleType("hermes_cli.runtime_provider")
    runtime_provider.resolve_runtime_provider = lambda **_kwargs: {"base_url": current_base_url}  # type: ignore[attr-defined]
    hermes_cli = types.ModuleType("hermes_cli")
    hermes_cli.runtime_provider = runtime_provider  # type: ignore[attr-defined]

    acp_session = types.ModuleType("acp_adapter.session")

    class SessionManager:
        _make_agent = staticmethod(fake_make_agent)

        def __init__(self) -> None:
            pass

        def _get_db(self) -> FakeDB:
            return db

    acp_session.SessionManager = SessionManager  # type: ignore[attr-defined]
    acp_adapter = types.ModuleType("acp_adapter")
    acp_adapter.session = acp_session  # type: ignore[attr-defined]

    sys.modules["hermes_cli"] = hermes_cli
    sys.modules["hermes_cli.runtime_provider"] = runtime_provider
    sys.modules["acp_adapter"] = acp_adapter
    sys.modules["acp_adapter.session"] = acp_session

    NS["_install_command_eve_acp_session_restore_patch"]()
    # The installer patched the CLASS attribute with a plain function, so an
    # instance call binds self — exactly like the wheel's restore path.
    return db


def make_row(base_url: str, provider: str, session_id: str) -> dict[str, object]:
    return {
        "source": "acp",
        "model": "command-eve-gemma4-e4b-64k:latest",
        "billing_provider": provider,
        "billing_base_url": base_url,
        "model_config": json.dumps({"cwd": f"/tmp/{session_id}", "provider": provider, "base_url": base_url}),
    }


def call_restore(db: FakeDB, **kwargs: object) -> dict[str, object]:
    MAKE_AGENT_CALLS.clear()
    SessionManagerCls = sys.modules["acp_adapter.session"].SessionManager  # type: ignore[attr-defined]
    manager = SessionManagerCls()
    manager._get_db = lambda: db  # type: ignore[attr-defined]
    bound = manager._make_agent
    return bound(**kwargs)


def scenario_a_to_b() -> dict[str, object]:
    row = make_row(BASE_A, "custom", "sess-a")
    db = install_with(BASE_B, row)
    result = call_restore(
        db,
        session_id="sess-a",
        cwd="/tmp/sess-a",
        model="command-eve-gemma4-e4b-64k:latest",
        requested_provider="custom",
        base_url=BASE_A,
        api_mode="chat_completions",
    )
    call = MAKE_AGENT_CALLS[0]
    persisted_ok = False
    if db.meta_writes:
        sid, meta_json = db.meta_writes[0]
        meta = json.loads(meta_json)
        persisted_ok = sid == "sess-a" and meta.get("base_url") == BASE_B and meta.get("provider") == "custom"
    return {
        "call_base_url": call.get("base_url"),
        "session_id_preserved": call.get("session_id") == "sess-a",
        "cwd_preserved": call.get("cwd") == "/tmp/sess-a",
        "api_mode_preserved": call.get("api_mode") == "chat_completions",
        "model_preserved": call.get("model") == "command-eve-gemma4-e4b-64k:latest",
        "persisted_to_b": persisted_ok,
        "result": bool(result),
    }


def scenario_remote_untouched() -> dict[str, object]:
    row = make_row(REMOTE_BASE, "custom", "sess-r")
    db = install_with(BASE_B, row)
    call_restore(
        db,
        session_id="sess-r",
        cwd="/tmp/sess-r",
        model="m",
        requested_provider="custom",
        base_url=REMOTE_BASE,
        api_mode="chat_completions",
    )
    call = MAKE_AGENT_CALLS[0]
    return {"call_base_url": call.get("base_url"), "no_meta_write": db.meta_writes == []}


def scenario_non_custom_untouched() -> dict[str, object]:
    row = make_row(BASE_A, "openrouter", "sess-n")
    db = install_with(BASE_B, row)
    call_restore(
        db,
        session_id="sess-n",
        cwd="/tmp/sess-n",
        model="m",
        requested_provider="openrouter",
        base_url=BASE_A,
        api_mode="chat_completions",
    )
    call = MAKE_AGENT_CALLS[0]
    return {"call_base_url": call.get("base_url"), "no_meta_write": db.meta_writes == []}


def scenario_current_missing_fail_closed() -> dict[str, object]:
    row = make_row(BASE_A, "custom", "sess-x")
    db = install_with("", row)  # current runtime base_url undeterminable
    call_restore(
        db,
        session_id="sess-x",
        cwd="/tmp/sess-x",
        model="m",
        requested_provider="custom",
        base_url=BASE_A,
        api_mode="chat_completions",
    )
    call = MAKE_AGENT_CALLS[0]
    return {"call_base_url": call.get("base_url"), "no_meta_write": db.meta_writes == []}


def scenario_current_remote_fail_closed() -> dict[str, object]:
    row = make_row(BASE_A, "custom", "sess-y")
    db = install_with(REMOTE_BASE, row)  # current runtime base_url NOT loopback
    call_restore(
        db,
        session_id="sess-y",
        cwd="/tmp/sess-y",
        model="m",
        requested_provider="custom",
        base_url=BASE_A,
        api_mode="chat_completions",
    )
    call = MAKE_AGENT_CALLS[0]
    return {"call_base_url": call.get("base_url"), "no_meta_write": db.meta_writes == []}


RESULT = {
    "a_to_b": scenario_a_to_b(),
    "remote_untouched": scenario_remote_untouched(),
    "non_custom_untouched": scenario_non_custom_untouched(),
    "current_missing_fail_closed": scenario_current_missing_fail_closed(),
    "current_remote_fail_closed": scenario_current_remote_fail_closed(),
}
print(json.dumps(RESULT))
