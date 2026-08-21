const pythonLines = (source: string): readonly string[] => source.split('\n');

/**
 * The 1.823.6 native Hermes compatibility seams are generated Python, but have
 * no I/O or runtime ownership of their own. The bootstrap writer composes these
 * lines in their existing positions to preserve the emitted source byte order.
 */
export const HERMES_NATIVE_PATCH_SOURCE = {
  imports: ['from contextvars import ContextVar'],
  expectedPatchNames: {
    webCapabilityTruth: '    "web_capability_truth",',
    executeCodeAuthority: '    "execute_code_authority",',
  },
  webCapabilityTruth: pythonLines(`def _command_eve_web_extract_available() -> bool:
    """Expose web_extract only when Hermes resolves a usable extract provider.

    Hermes 0.20 registers web_search and web_extract with the same broad
    check_web_api_key predicate. A search-only provider such as DDGS therefore
    exposes both schemas even though its native supports_extract() is False.
    Reuse Hermes' own plugin discovery and capability resolver, then require
    the resolved provider to be genuinely available. Any inspection failure is
    absence of proof and therefore keeps the paid/external tool hidden.
    """
    try:
        from tools.web_tools import _ensure_web_plugins_loaded
        _ensure_web_plugins_loaded()
        from agent.web_search_registry import get_active_extract_provider
        provider = get_active_extract_provider()
        return bool(
            provider is not None
            and provider.supports_extract()
            and provider.is_available()
        )
    except Exception:
        return False


def _install_command_eve_web_capability_truth_patch() -> None:
    """Give web_extract its own native capability-aware availability check."""
    try:
        from tools.registry import invalidate_check_fn_cache, registry
    except Exception:
        return
    entry = registry.get_entry("web_extract")
    if entry is None or entry.toolset != "web":
        return
    if entry.check_fn is _command_eve_web_extract_available:
        _command_eve_mark_patch("web_capability_truth")
        return
    try:
        # Re-register through Hermes' public registry seam. Same-toolset
        # replacement is native and bumps the registry generation, so cached
        # model definitions cannot retain the old shared web check.
        registry.register(
            name=entry.name,
            toolset=entry.toolset,
            schema=entry.schema,
            handler=entry.handler,
            check_fn=_command_eve_web_extract_available,
            requires_env=entry.requires_env,
            is_async=entry.is_async,
            description=entry.description,
            emoji=entry.emoji,
            max_result_size_chars=entry.max_result_size_chars,
            dynamic_schema_overrides=entry.dynamic_schema_overrides,
        )
        invalidate_check_fn_cache()
        try:
            from model_tools import _clear_tool_defs_cache
            _clear_tool_defs_cache()
        except Exception:
            pass
    except Exception:
        return
    _command_eve_mark_patch("web_capability_truth")

`),
  executeCodeAuthority: pythonLines(`# The structured tool-authority gate and the wheel-internal execute_code
# guard answered the same question through two different surfaces. The tool
# gate consulted the seat grant, while check_execute_code_guard could only put
# a gateway pending record into a queue that the ACP desktop never renders.
# Reconcile them at the existing authority decision: a grant that already
# allows execute_code gets one operation approved; every other result keeps
# the original guard response (including hard blocks and denial breakers).
def _install_command_eve_execute_code_authority() -> None:
    try:
        from tools import approval as command_eve_tools_approval
    except Exception:
        return
    original_guard = getattr(command_eve_tools_approval, "check_execute_code_guard", None)
    if not callable(original_guard) or getattr(
        original_guard, "_command_eve_authority_patch", False
    ):
        return

    def command_eve_check_execute_code_guard(
        code: str, env_type: str, has_host_access: bool = False, **kwargs: Any
    ) -> dict:
        result = original_guard(code, env_type, has_host_access=has_host_access, **kwargs)
        if result.get("approved") is not False or result.get("approval_pending") is not True:
            return result
        if str(result.get("pattern_key") or "") != "execute_code":
            return result
        try:
            authority = _command_eve_ask_tool_authority("execute_code", "")
        except Exception:
            authority = {"decision": "ask"}
        if authority.get("decision") != "allow":
            return result
        return {
            "approved": True,
            "message": None,
            "user_approved": True,
            "authority_approved": True,
            "pattern_key": "execute_code",
            "description": result.get("description"),
        }

    command_eve_check_execute_code_guard._command_eve_authority_patch = True
    command_eve_tools_approval.check_execute_code_guard = command_eve_check_execute_code_guard
    _command_eve_mark_patch("execute_code_authority")

`),
  clarify: {
    contextDeclaration: pythonLines(`_COMMAND_EVE_ACP_CLARIFY_CONTEXT: ContextVar[dict[str, Any] | None] = ContextVar(
    "command_eve_acp_clarify_context", default=None
)`),
    contextLookup: ['    context = _COMMAND_EVE_ACP_CLARIFY_CONTEXT.get()'],
    bindAndUnbind: pythonLines(`def _command_eve_bind_acp_clarify(
    agent: Any, session_id: str, request_permission: Any, loop: Any,
    loop_thread_id: int, owner: object,
) -> Any:
    """Bind only turn-scoped ACP routing; never store model-hidden authority."""
    if not session_id or not callable(request_permission):
        raise RuntimeError("Command EVE ACP clarify binding is incomplete")
    context = {
        "session_id": session_id,
        "owner": owner,
        "request_permission": request_permission,
        "loop": loop,
        "loop_thread_id": loop_thread_id,
    }
    with _COMMAND_EVE_ACP_CLARIFY_LOCK:
        agent_key = id(agent)
        record = _COMMAND_EVE_ACP_CLARIFY_AGENTS.get(agent_key)
        if record is None:
            record = {
                "agent": agent,
                "previous": getattr(agent, "clarify_callback", None),
                "owners": [],
            }
            _COMMAND_EVE_ACP_CLARIFY_AGENTS[agent_key] = record
        record["owners"].append(owner)
        agent.clarify_callback = _command_eve_acp_clarify_callback
    return _COMMAND_EVE_ACP_CLARIFY_CONTEXT.set(context)


def _command_eve_unbind_acp_clarify(agent: Any, owner: object, context_token: Any) -> None:
    """Remove exactly one turn binding and restore the pre-existing callback."""
    _COMMAND_EVE_ACP_CLARIFY_CONTEXT.reset(context_token)
    with _COMMAND_EVE_ACP_CLARIFY_LOCK:
        agent_key = id(agent)
        record = _COMMAND_EVE_ACP_CLARIFY_AGENTS.get(agent_key)
        if record is None or record.get("agent") is not agent:
            return
        owners = [item for item in (record.get("owners") or []) if item is not owner]
        if owners:
            record["owners"] = owners
            return
        if getattr(agent, "clarify_callback", None) is _command_eve_acp_clarify_callback:
            agent.clarify_callback = record.get("previous")
        _COMMAND_EVE_ACP_CLARIFY_AGENTS.pop(agent_key, None)

`),
    promptBinding: pythonLines(`        conn = getattr(self, "_conn", None)
        owner = object()
        clarify_agent = None
        clarify_context_token = None
        if conn is not None and session_id:
            try:
                manager = getattr(self, "session_manager", None)
                state = manager.get_session(session_id) if manager is not None else None
                clarify_agent = getattr(state, "agent", None)
                if clarify_agent is not None:
                    clarify_context_token = _command_eve_bind_acp_clarify(
                        clarify_agent,
                        session_id,
                        conn.request_permission,
                        asyncio.get_running_loop(),
                        threading.get_ident(),
                        owner,
                    )
            except Exception as exc:
                logging.getLogger(__name__).warning(
                    "Command EVE could not bind Hermes 0.20 ACP clarify",
                    exc_info=True,
                )
                raise RuntimeError("Command EVE ACP clarify binding failed") from exc
        if clarify_agent is None:
            raise RuntimeError("Command EVE ACP clarify binding unavailable")
        try:
            return await original_prompt(self, *args, **kwargs)
        finally:
            if clarify_agent is not None and clarify_context_token is not None:
                _command_eve_unbind_acp_clarify(clarify_agent, owner, clarify_context_token)`),
    requirePatch: pythonLines(`def _require_command_eve_acp_clarify_patch() -> None:
    """Fail closed when the native Hermes 0.20 clarify seam is unavailable."""
    if "acp_clarify" not in _COMMAND_EVE_INSTALLED_PATCHES:
        raise RuntimeError("Command EVE requires the Hermes 0.20 ACP clarify seam")

`),
  },
  installers: {
    profileWebCapabilityTruth: '        _install_command_eve_web_capability_truth_patch()',
    profileExecuteCodeAuthority: '        _install_command_eve_execute_code_authority()',
    profileClarify: '        _require_command_eve_acp_clarify_patch()',
    moduleWebCapabilityTruth: '_install_command_eve_web_capability_truth_patch()',
    moduleExecuteCodeAuthority: '_install_command_eve_execute_code_authority()',
  },
} as const;
