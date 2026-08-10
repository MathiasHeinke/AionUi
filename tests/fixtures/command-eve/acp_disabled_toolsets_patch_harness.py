"""Contract harness for Command EVE's Hermes 0.20 ACP toolset shim.

Exercises the emitted provider override at the exact SessionManager._make_agent
seam. The fake refresher mirrors Hermes' native refresh contract so the harness
proves the wrapper passes config-owned disabled toolsets into that contract,
publishes the filtered tool snapshot, and leaves a verified local-VLM session
unchanged.
"""

from __future__ import annotations

import ast
import json
import sys
import types
from pathlib import Path

OVERRIDE_PATH = Path(sys.argv[1]).resolve()
SOURCE = OVERRIDE_PATH.read_text(encoding="utf-8")


def load_symbols() -> dict[str, object]:
    tree = ast.parse(SOURCE, filename=str(OVERRIDE_PATH))
    selected = {
        "_command_eve_apply_acp_disabled_toolsets",
        "_install_command_eve_acp_disabled_toolsets_patch",
        "_command_eve_mark_patch",
    }
    selected_globals = {"_COMMAND_EVE_EXPECTED_PATCHES", "_COMMAND_EVE_INSTALLED_PATCHES"}
    body: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, ast.Import) and all(alias.name in {"logging"} for alias in node.names):
            body.append(node)
        elif isinstance(node, ast.ImportFrom) and node.module in {"typing", "__future__"}:
            body.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in selected:
            body.append(node)
        elif isinstance(node, ast.Assign) and {
            target.id for target in node.targets if isinstance(target, ast.Name)
        } & selected_globals:
            body.append(node)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id in selected_globals:
            body.append(node)
    namespace: dict[str, object] = {}
    exec(compile(ast.fix_missing_locations(ast.Module(body=body, type_ignores=[])), str(OVERRIDE_PATH), "exec"), namespace)
    missing = selected - set(namespace)
    if missing:
        raise SystemExit(f"emitted override is missing ACP toolset symbols: {sorted(missing)}")
    return namespace


NS = load_symbols()
CONFIG: dict[str, object] = {"agent": {"disabled_toolsets": ["vision", "vision"]}}
REFRESH_CALLS: list[list[str]] = []
DB_WRITES: list[tuple[str, object]] = []


class FakeSessionDB:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, object]] = {
            "restored": {"system_prompt": "STALE_VISION_GUIDANCE: vision_analyze"},
            "local-vlm": {"system_prompt": "LOCAL_VLM_PROMPT"},
        }

    def get_session(self, session_id: str):
        return self.rows.get(session_id)

    def update_system_prompt(self, session_id: str, prompt) -> None:
        DB_WRITES.append((session_id, prompt))
        self.rows.setdefault(session_id, {})["system_prompt"] = prompt


SESSION_DB = FakeSessionDB()


class FakeAgent:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self._session_db = SESSION_DB
        self.enabled_toolsets = ["hermes-acp"]
        self.disabled_toolsets = None
        self.tools = [
            {"function": {"name": "terminal"}},
            {"function": {"name": "vision_analyze"}},
        ]
        self.valid_tool_names = {"terminal", "vision_analyze"}
        self.invalidations = 0

    def _invalidate_system_prompt(self) -> None:
        self.invalidations += 1


def fake_make_agent(_self: object, *_args: object, **kwargs: object) -> FakeAgent:
    return FakeAgent(str(kwargs.get("session_id") or ""))


def fake_refresh(agent: FakeAgent, *, disabled_override=None, **_kwargs: object) -> set[str]:
    disabled = list(disabled_override or agent.disabled_toolsets or [])
    REFRESH_CALLS.append(disabled)
    agent.disabled_toolsets = disabled
    if "vision" in disabled:
        agent.tools = [tool for tool in agent.tools if tool["function"]["name"] != "vision_analyze"]
    agent.valid_tool_names = {tool["function"]["name"] for tool in agent.tools}
    return set()


config_module = types.ModuleType("hermes_cli.config")
config_module.load_config = lambda: CONFIG  # type: ignore[attr-defined]
hermes_cli = types.ModuleType("hermes_cli")
hermes_cli.config = config_module  # type: ignore[attr-defined]

mcp_module = types.ModuleType("tools.mcp_tool")
mcp_module.refresh_agent_mcp_tools = fake_refresh  # type: ignore[attr-defined]
tools_module = types.ModuleType("tools")
tools_module.mcp_tool = mcp_module  # type: ignore[attr-defined]

session_module = types.ModuleType("acp_adapter.session")


class SessionManager:
    _make_agent = fake_make_agent


session_module.SessionManager = SessionManager  # type: ignore[attr-defined]
acp_adapter = types.ModuleType("acp_adapter")
acp_adapter.session = session_module  # type: ignore[attr-defined]

sys.modules.update(
    {
        "hermes_cli": hermes_cli,
        "hermes_cli.config": config_module,
        "tools": tools_module,
        "tools.mcp_tool": mcp_module,
        "acp_adapter": acp_adapter,
        "acp_adapter.session": session_module,
    }
)

NS["_install_command_eve_acp_disabled_toolsets_patch"]()
wrapped_once = SessionManager._make_agent
NS["_install_command_eve_acp_disabled_toolsets_patch"]()
idempotent = wrapped_once is SessionManager._make_agent

manager = SessionManager()
fresh = manager._make_agent(session_id="fresh")
restored = manager._make_agent(session_id="restored")

# A later native tool refresh reads the persisted disabled selection and must
# not re-surface vision_analyze through tool search or MCP refresh.
fake_refresh(fresh)

CONFIG = {"agent": {}}
local_vlm = manager._make_agent(session_id="local-vlm")

print(
    json.dumps(
        {
            "fresh": {
                "disabled": fresh.disabled_toolsets,
                "vision_absent": "vision_analyze" not in fresh.valid_tool_names,
                "terminal_present": "terminal" in fresh.valid_tool_names,
                "prompt_invalidations": fresh.invalidations,
            },
            "restored_vision_absent": "vision_analyze" not in restored.valid_tool_names,
            "restored_prompt_invalidated": SESSION_DB.rows["restored"]["system_prompt"] is None,
            "db_writes": DB_WRITES,
            "later_refresh_stays_filtered": "vision_analyze" not in fresh.valid_tool_names,
            "local_vlm_keeps_vision": "vision_analyze" in local_vlm.valid_tool_names,
            "refresh_disabled_args": REFRESH_CALLS,
            "idempotent_install": idempotent,
            "ledger_marked": "acp_disabled_toolsets" in NS["_COMMAND_EVE_INSTALLED_PATCHES"],
        }
    )
)
