#!/usr/bin/env python3
"""Measure Hermes 0.20 progressive tool disclosure for a realistic Command EVE ACP seat.

Runs the REAL ``tools/tool_search.py`` and the REAL ``toolsets.py`` out of the
bundled wheel against a registry populated the way the product populates it:
the native ``hermes-acp`` toolset, the desktop GUI affordances the wheel
registers itself (``open_preview``, ``focus_pane``, ``read_terminal``), the
``read_preview`` schema the Command EVE shim appends, and the two built-in MCP
servers.  Only the tool handlers are replaced; every classification, token and
listing decision is Hermes' own code.

No provider, no inference, no network, no Electron.  Deterministic: the catalog
listing is byte-stable by construction (tool_search.py sorts groups and tools),
and every schema here is either loaded from the wheel or transcribed verbatim
from the emitting source file named beside it.

Usage:
    python3 tests/fixtures/command-eve/hermes_tool_search_disclosure_harness.py \
        <path-to-hermes_agent-0.20.0-py3-none-any.whl>
"""

from __future__ import annotations

import json
import subprocess
import sys
import types
import zipfile
from pathlib import Path
from typing import Any

WHEEL_PATH = Path(sys.argv[1]).resolve()

# Measurement mode.  Each mutation variant runs in its OWN process (spawned by
# the "main" mode below) so an append in one variant can never contaminate the
# rebind measured in another.
#   main            — the seat measurement, plus every sub-run embedded
#   append          — Variant 1: _HERMES_CORE_TOOLS.append(...)
#   rebind          — Variant 2: _HERMES_CORE_TOOLS = list(old) + product names
#   baseline_67mcp  — 11 product tools + 67 foreign MCP tools, NO mutation
#   rebind_67mcp    — the same 78, WITH the rebind
MODE = sys.argv[2] if len(sys.argv) > 2 else "main"

# The Command EVE product surface: the tools the seat needs constantly and
# which classify as deferrable today (measured in the "main" mode).
PRODUCT_TOOL_NAMES = [
    "eve_artifact_get",
    "eve_artifact_list",
    "eve_typed_ui_publish",
    "eve_video_edit",
    "eve_image_edit",
    "eve_video_generate",
    "aionui_image_generation",
    "open_preview",
    "read_preview",
    "focus_pane",
    "read_terminal",
]

# The model-facing context window this seat is assembled against.  Only the
# listing budget reads it (tool_search.listing_token_budget); activation does
# not.  262144 = the 256K window the Command EVE seat is measured at.
CONTEXT_LENGTH = 262_144


# ---------------------------------------------------------------------------
# Minimal host: module installation + wheel loading (same shape as
# hermes_desktop_bridge_concurrency_harness.py)
# ---------------------------------------------------------------------------


def install_module(name: str, module: types.ModuleType) -> None:
    sys.modules[name] = module
    parent_name, _, child_name = name.rpartition(".")
    if parent_name:
        setattr(sys.modules[parent_name], child_name, module)


def load_wheel_module(name: str, entry: str, package: str | None = None) -> types.ModuleType:
    with zipfile.ZipFile(WHEEL_PATH) as archive:
        source = archive.read(entry).decode("utf-8")
    module = types.ModuleType(name)
    module.__file__ = f"{WHEEL_PATH}!/{entry}"
    if package is not None:
        module.__package__ = package
    install_module(name, module)
    exec(compile(source, module.__file__, "exec"), module.__dict__)
    return module


class FakeEntry:
    """Shape-compatible stand-in for tools.registry.ToolEntry.

    tool_search only ever reads ``.toolset`` (classification, catalog source)
    and ``.schema`` (probe validation via registry.get_schema).
    """

    def __init__(self, name: str, toolset: str, schema: dict[str, Any]) -> None:
        self.name = name
        self.toolset = toolset
        self.schema = schema


class FakeRegistry:
    def __init__(self) -> None:
        self.entries: dict[str, FakeEntry] = {}

    def register(self, **kwargs: Any) -> None:
        name = str(kwargs["name"])
        self.entries[name] = FakeEntry(name, str(kwargs["toolset"]), kwargs.get("schema") or {})

    def get_entry(self, name: str) -> FakeEntry | None:
        return self.entries.get(name)

    def get_schema(self, name: str) -> dict[str, Any] | None:
        # Mirrors registry.get_schema (tools/registry.py:854-861).
        entry = self.get_entry(name)
        return entry.schema if entry else None

    # --- the surface toolsets.get_toolset / resolve_toolset actually calls ---

    def get_tool_names_for_toolset(self, toolset: str) -> list[str]:
        return sorted(n for n, e in self.entries.items() if e.toolset == toolset)

    def get_registered_toolset_names(self) -> list[str]:
        return sorted({e.toolset for e in self.entries.values()})

    def get_toolset_alias_target(self, _alias: str) -> str | None:
        return None

    def get_registered_toolset_aliases(self) -> dict[str, str]:
        return {}


registry = FakeRegistry()


def tool_error(message: str, **extra: Any) -> str:
    # Mirrors tools/registry.py:974-986 (no error-text bounding needed here).
    result: dict[str, Any] = {"error": str(message)}
    if extra:
        result.update(extra)
    return json.dumps(result, ensure_ascii=False)


def get_session_env(_name: str, default: str = "") -> str:
    return default


tools_package = types.ModuleType("tools")
tools_package.__path__ = []  # type: ignore[attr-defined]
install_module("tools", tools_package)
registry_module = types.ModuleType("tools.registry")
registry_module.registry = registry  # type: ignore[attr-defined]
registry_module.tool_error = tool_error  # type: ignore[attr-defined]
install_module("tools.registry", registry_module)

gateway_package = types.ModuleType("gateway")
gateway_package.__path__ = []  # type: ignore[attr-defined]
install_module("gateway", gateway_package)
session_context_module = types.ModuleType("gateway.session_context")
session_context_module.get_session_env = get_session_env  # type: ignore[attr-defined]
install_module("gateway.session_context", session_context_module)


# A registered plugin platform, so the auto-generated-toolset branch in
# toolsets.resolve_toolset (toolsets.py:805-822) is actually reachable.  That
# branch builds ``set(_HERMES_CORE_TOOLS)`` LAZILY at call time, which makes it
# the one place a rebind can still leak into a resolved toolset.
FAKE_PLUGIN_PLATFORM = "fakeplugin"


class _FakePlatformRegistry:
    def is_registered(self, name: str) -> bool:
        return name == FAKE_PLUGIN_PLATFORM


platform_registry_module = types.ModuleType("gateway.platform_registry")
platform_registry_module.platform_registry = _FakePlatformRegistry()  # type: ignore[attr-defined]
install_module("gateway.platform_registry", platform_registry_module)

# REAL toolsets.py from the wheel: _HERMES_CORE_TOOLS and the hermes-acp list
# are read from it rather than transcribed, so a wheel bump moves this harness.
toolsets = load_wheel_module("toolsets", "toolsets.py")

# REAL desktop GUI tools.  Importing them runs their module-level
# registry.register(...), which puts their REAL schemas into FakeRegistry.
load_wheel_module("tools.desktop_ui", "tools/desktop_ui.py", package="tools")
load_wheel_module("tools.open_preview_tool", "tools/open_preview_tool.py", package="tools")
load_wheel_module("tools.focus_pane_tool", "tools/focus_pane_tool.py", package="tools")
load_wheel_module("tools.read_terminal_tool", "tools/read_terminal_tool.py", package="tools")

# REAL tool_search.py — the subject under measurement.
ts = load_wheel_module("tools.tool_search", "tools/tool_search.py", package="tools")


# ---------------------------------------------------------------------------
# Schemas the wheel does not carry, transcribed verbatim from their emitter
# ---------------------------------------------------------------------------

# packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts:8836-8851
READ_PREVIEW_SCHEMA: dict[str, Any] = {
    "name": "read_preview",
    "description": (
        "Read what is currently visible in the in-app browser or preview pane for this "
        "Command EVE conversation. Returns rendered browser text and metadata; file and "
        "artifact previews return identity plus a note. Use start/count to page long text."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "start": {"type": "integer", "minimum": 0},
            "count": {"type": "integer", "minimum": 1, "maximum": 24000},
        },
        "additionalProperties": False,
    },
}

# packages/desktop/src/process/resources/builtinMcp/eveArtifactContextServer.ts:134-145
_HANDLE_DESC = (
    "The opaque `edit_handle` copied VERBATIM from the artifact registry in your context. "
    "Never an artifact id, a filename, a conversation id or a guess — those are refused."
)
_PERMIT_DESC = (
    "The single-use `spend_permit` from THIS request in your context, copied VERBATIM. "
    "It authorises exactly one paid edit for the request the user just made. It cannot be "
    "reused for a second variation, and there is no way to obtain another one except the "
    "user asking again."
)

# Descriptions: packages/desktop/src/process/resources/builtinMcp/eveArtifactToolSurface.ts:60-116
# Parameter shapes: eveArtifactContextServer.ts:154-278 (zod -> JSON Schema as the
# MCP SDK emits it; `required` = the non-.optional() fields).
EVE_ARTIFACT_TOOLS: list[dict[str, Any]] = [
    {
        "name": "eve_artifact_get",
        "description": (
            "Read what Command EVE knows about ONE artifact the user already has, by its "
            "capability handle. Returns its kind, whether it can be edited, and — when the "
            "conversation has a project workspace — its project-relative file path. Use that "
            "relative path directly from the current workspace. When no file path is present, "
            "the artifact is app-managed for this conversation: reference it by its capability "
            "handle, never by a file path. Costs nothing and changes nothing."
        ),
        "parameters": {
            "type": "object",
            "properties": {"handle": {"type": "string", "description": _HANDLE_DESC}},
            "required": ["handle"],
        },
    },
    {
        "name": "eve_artifact_list",
        "description": (
            "Read several artifacts at once, by the capability handles from your context. "
            "There is deliberately no way to list a conversation by id: a handle is the only "
            "thing that proves you were given the artifact."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "handles": {
                    "type": "array",
                    "items": {"type": "string", "description": _HANDLE_DESC},
                    "minItems": 1,
                    "maxItems": 24,
                }
            },
            "required": ["handles"],
        },
    },
    {
        "name": "eve_typed_ui_publish",
        "description": (
            "Publish one declarative Command EVE Typed UI envelope. The app validates the "
            "fixed schema and 45-component catalog and returns a renderable artifact. This "
            "cannot run JavaScript, CSS, HTML, shell, IPC or network actions."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "envelope": {
                    "type": "object",
                    "additionalProperties": True,
                    "description": (
                        "One complete command-eve.typed-ui/v2 JSON envelope using the fixed catalog."
                    ),
                }
            },
            "required": ["envelope"],
        },
    },
    {
        "name": "eve_video_edit",
        "description": (
            "Edit a video the user already has. Takes the capability handle for the SOURCE "
            "clip, the single-use spend permit from this request, and a plain instruction "
            "(\"give the aubergine a face\"). The result is a NEW video saved beside the "
            "original — the original is never overwritten. Quality and length are inherited "
            "from the source and cannot be chosen. This spends the user's credits, ONCE: the "
            "permit is consumed, and a second edit — including a different variation of the "
            "same one — needs the user to ask again."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "handle": {"type": "string", "description": _HANDLE_DESC},
                "permit": {"type": "string", "description": _PERMIT_DESC},
                "instruction": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000,
                    "description": "What should change about the video, in the user's own terms.",
                },
            },
            "required": ["handle", "permit", "instruction"],
        },
    },
    {
        "name": "eve_image_edit",
        "description": (
            "Edit an image the user already has. Takes the capability handle for the SOURCE "
            "image (an `edit_handle` from a kind=image entry in your context) and a plain "
            "instruction (\"make the sky overcast\"). The result is a NEW image — the original "
            "is never overwritten — returned as a fresh staged reference (`img_h_…`) you may "
            "show the user. Command EVE uses the current native Hermes ACP permission mode for "
            "this paid tool; never ask for, invent or expose an internal permit, quote or billing receipt."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "handle": {"type": "string", "description": _HANDLE_DESC},
                "instruction": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000,
                    "description": "What should change about the image, in the user's own terms.",
                },
            },
            "required": ["handle", "instruction"],
        },
    },
    {
        "name": "eve_video_generate",
        "description": (
            "Generate a NEW short video from a text prompt, in a conversation that already "
            "has a Command EVE artifact — pass any capability handle from your context to say "
            "which conversation. Use this ONLY when the user asked for a video in this turn; "
            "it is not a utility to call on your own initiative. Length and quality are chosen "
            "by the app and cannot be requested. This spends the user's credits EVERY time it "
            "is called, so call it once and show the result — do not retry a wording, and do "
            "not produce variations unless the user asks for another one."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "handle": {"type": "string", "description": _HANDLE_DESC},
                "prompt": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000,
                    "description": (
                        "What the video should show, in the user's own terms — subject, motion, style."
                    ),
                },
            },
            "required": ["handle", "prompt"],
        },
    },
]

# packages/desktop/src/process/resources/builtinMcp/imageGenServer.ts:70-133
IMAGE_GEN_DESCRIPTION = """REQUIRED tool for generating new images. You MUST use this tool for ANY image generation request.

CRITICAL: You (the AI assistant) CANNOT generate images directly. You MUST call this tool for:
- Creating/generating any new images from text descriptions
- Drawing, painting, or making any visual content
- Editing or modifying ordinary local/remote image files on non-managed providers

Primary Functions:
- Generate new images from English text descriptions
- Edit/modify existing images with English text prompts

IMPORTANT: All prompts must be in English for optimal results.

When to Use (MANDATORY):
- User asks to "generate", "create", "draw", "make", "paint" an image
- User asks for any visual content creation
- User asks to edit or modify an ordinary local/remote image file on a non-managed provider
- User mentions @filename with image extensions (.jpg, .jpeg, .png, .gif, .webp, .bmp, .tiff, .svg)

Input Support:
- Multiple local file paths in array format: ["img1.jpg", "img2.png"]
- Multiple HTTP/HTTPS image URLs in array format
- Text prompts for generation or analysis

Output:
- Managed (Command EVE) lane: the image is stored privately by the app and the
  result names an internal artifact reference (img_h_...) plus human metadata —
  NEVER a file path. To edit an existing managed artifact, MUST use the separate
  `eve_image_edit` tool with the `edit_handle` supplied in conversation context.
  Never pass an img_h_ reference as a local path, search the filesystem or app
  database for it, or regenerate the image merely to obtain a file path.
- Other providers: saves generated/processed images to workspace with timestamp naming
- Returns image path and AI description/analysis

IMPORTANT: When user provides multiple images, ALWAYS pass ALL images to the image_uris parameter as an array."""

IMAGE_GEN_TOOL: dict[str, Any] = {
    "name": "aionui_image_generation",
    "description": IMAGE_GEN_DESCRIPTION,
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": (
                    'The text prompt in English that must clearly specify the operation type: '
                    '"Generate image: [description]" for creating new images, "Analyze image: '
                    '[what to analyze]" for image recognition/analysis, or "Edit image: '
                    '[modifications]" for image editing.'
                ),
            },
            "image_uris": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    'Optional: Array of paths to existing local image files or HTTP/HTTPS URLs '
                    'to edit/modify. Examples: ["test.jpg", "https://example.com/img.png"]. '
                    'For single image, use array format: ["test.jpg"].'
                ),
            },
            "aspect_ratio": {
                "type": "string",
                "enum": ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
                "description": (
                    "Optional output aspect ratio. Use 16:9 for slide directions and desktop "
                    "website hero directions."
                ),
            },
            "resolution": {
                "type": "string",
                "enum": ["1K", "2K"],
                "description": (
                    "Optional output resolution. Use 1K for selection drafts and 2K only for a "
                    "user-selected final direction."
                ),
            },
            "workspace_dir": {
                "type": "string",
                "description": (
                    "Non-managed providers only: working directory for resolving relative paths "
                    "and saving output images. The Command EVE managed lane ignores this value, "
                    "returns an internal artifact, and uses native artifact export when the user "
                    "wants a file."
                ),
            },
        },
        "required": ["prompt"],
    },
}


def as_tool_def(schema: dict[str, Any]) -> dict[str, Any]:
    """Wrap a raw registry schema the way registry.get_definitions() does."""
    return {
        "type": "function",
        "function": {
            "name": schema["name"],
            "description": schema.get("description", ""),
            "parameters": schema.get("parameters", {}),
        },
    }


# ---------------------------------------------------------------------------
# Seat assembly
# ---------------------------------------------------------------------------

ACP_TOOL_NAMES: list[str] = list(toolsets.TOOLSETS["hermes-acp"]["tools"])
CORE_TOOL_NAMES: frozenset[str] = frozenset(toolsets._HERMES_CORE_TOOLS)

# The native hermes-acp tools are all core (proved in the output below), so
# classification never reads their schema and their token cost is identical
# with and without the bridge.  A placeholder body keeps that honest: it is
# excluded from the token delta, which counts only DEFERRABLE schemas.
ACP_PLACEHOLDER_SCHEMAS = {
    name: {
        "name": name,
        "description": f"<hermes-acp native tool {name}; body not loaded — see notes>",
        "parameters": {"type": "object", "properties": {}},
    }
    for name in ACP_TOOL_NAMES
}

for _name, _schema in ACP_PLACEHOLDER_SCHEMAS.items():
    registry.register(name=_name, toolset="hermes-acp", schema=_schema)

# read_preview: appended by the Command EVE shim under its own toolset.
registry.register(name="read_preview", toolset="command-eve-desktop", schema=READ_PREVIEW_SCHEMA)

# The two built-in MCP servers.
for _tool in EVE_ARTIFACT_TOOLS:
    registry.register(name=_tool["name"], toolset="mcp-aionui-eve-artifacts", schema=_tool)
registry.register(
    name=IMAGE_GEN_TOOL["name"], toolset="mcp-builtin-mcp-image-gen", schema=IMAGE_GEN_TOOL
)

# open_preview / focus_pane / read_terminal registered themselves on import
# with their REAL wheel schemas under toolset "desktop_ui".
WHEEL_DESKTOP_TOOLS = ["open_preview", "focus_pane", "read_terminal"]

SEAT_TOOL_DEFS: list[dict[str, Any]] = (
    [as_tool_def(ACP_PLACEHOLDER_SCHEMAS[n]) for n in ACP_TOOL_NAMES]
    + [as_tool_def(registry.get_schema(n) or {}) for n in WHEEL_DESKTOP_TOOLS]
    + [as_tool_def(READ_PREVIEW_SCHEMA)]
    + [as_tool_def(t) for t in EVE_ARTIFACT_TOOLS]
    + [as_tool_def(IMAGE_GEN_TOOL)]
)


# ---------------------------------------------------------------------------
# (1) Classification
# ---------------------------------------------------------------------------

visible, deferrable = ts.classify_tools(SEAT_TOOL_DEFS)
deferrable_names = sorted(td["function"]["name"] for td in deferrable)

desktop_affordances = ["open_preview", "read_preview", "focus_pane", "read_terminal"]
classification = {
    "seat_tool_count": len(SEAT_TOOL_DEFS),
    "visible_count": len(visible),
    "deferrable_count": len(deferrable),
    "deferrable_names": deferrable_names,
    "hermes_acp_native_count": len(ACP_TOOL_NAMES),
    "hermes_acp_all_core": sorted(set(ACP_TOOL_NAMES) - CORE_TOOL_NAMES) == [],
    "desktop_affordances_deferrable": {
        name: ts.is_deferrable_tool_name(name) for name in desktop_affordances
    },
    "desktop_affordances_in_core_list": {
        name: (name in CORE_TOOL_NAMES) for name in desktop_affordances
    },
    "registered_toolset_of": {
        name: (registry.get_entry(name).toolset if registry.get_entry(name) else None)
        for name in desktop_affordances
    },
}


# ---------------------------------------------------------------------------
# (2) Token delta  +  (3) tier / listing form
# ---------------------------------------------------------------------------

# Command EVE emits no `tools.tool_search` key in its Hermes config
# (runtimeBootstrapCore.ts), so the seat runs on Hermes' own defaults.
config = ts.ToolSearchConfig.from_raw(None)

eager_tokens = ts.estimate_tokens_from_schemas(deferrable)
assembly = ts.assemble_tool_defs(SEAT_TOOL_DEFS, context_length=CONTEXT_LENGTH, config=config)
bridge_defs = [td for td in assembly.tool_defs if td["function"]["name"] in ts.BRIDGE_TOOL_NAMES]
bridge_tokens = ts.estimate_tokens_from_schemas(bridge_defs)

token_delta = {
    "context_length": CONTEXT_LENGTH,
    "config": {
        "enabled": config.enabled,
        "threshold_pct": config.threshold_pct,
        "listing": config.listing,
        "listing_max_tokens": config.listing_max_tokens,
        "source": "ToolSearchConfig.from_raw(None) — product emits no tools.tool_search key",
    },
    "deferrable_schemas_eager_tokens": eager_tokens,
    "bridge_schemas_with_listing_tokens": bridge_tokens,
    "saved_tokens": eager_tokens - bridge_tokens,
    "listing_token_budget": ts.listing_token_budget(config, CONTEXT_LENGTH),
    "bridge_tool_count": len(bridge_defs),
    "assembled_tool_count": len(assembly.tool_defs),
}

tier_and_listing = {
    "activated": assembly.activated,
    "tier": assembly.tier,
    "listing_form": assembly.listing_form,
    "deferred_count": assembly.deferred_count,
    "deferred_tokens": assembly.deferred_tokens,
    "listing_groups": sorted(
        {
            ts._listing_group_label(ts._classify_source(td["function"]["name"])[1])
            for td in deferrable
        }
    ),
}


# ---------------------------------------------------------------------------
# (4) Is tool_describe mechanically required before tool_call?
# ---------------------------------------------------------------------------

HANDLE = "evecap_" + "0" * 32
PERMIT = "evespend_" + "0" * 32

# Complete-argument call, never preceded by tool_describe in this process.
complete_name, complete_args, complete_err = ts.resolve_underlying_call(
    {
        "name": "eve_video_edit",
        "arguments": {"handle": HANDLE, "permit": PERMIT, "instruction": "make it rain"},
    }
)
complete_probe = ts.validate_deferred_call_args(complete_name or "", complete_args)

# Counter-example: the same tool with `instruction` withheld.
missing_name, missing_args, missing_err = ts.resolve_underlying_call(
    {"name": "eve_video_edit", "arguments": {"handle": HANDLE, "permit": PERMIT}}
)
missing_probe = ts.validate_deferred_call_args(missing_name or "", missing_args)

describe_enforcement = {
    "tool_describe_called_before_either_case": False,
    "complete_args_call": {
        "resolved_name": complete_name,
        "resolve_error": complete_err,
        "probe_result": complete_probe,
        "dispatches_without_describe": complete_err is None and complete_probe is None,
    },
    "missing_required_arg_call": {
        "resolved_name": missing_name,
        "resolve_error": missing_err,
        "probe_returned_error": missing_probe is not None,
        "probe_result": json.loads(missing_probe) if missing_probe else None,
    },
}


# ---------------------------------------------------------------------------
# (A) Object identity: is TOOLSETS[...]["tools"] the SAME list object as
#     _HERMES_CORE_TOOLS?  If it is, `.append()` mutates every sharing toolset.
# ---------------------------------------------------------------------------

CORE_LIST = toolsets._HERMES_CORE_TOOLS
IDENTITY_PROBE_TOOLSETS = [
    "hermes-cli",       # toolsets.py:500  "tools": _HERMES_CORE_TOOLS
    "hermes-cron",      # toolsets.py:511  same
    "hermes-telegram",  # toolsets.py:517  same
    "hermes-discord",   # toolsets.py:523  _HERMES_CORE_TOOLS + [...] (new list)
    "hermes-acp",       # toolsets.py:440  its own literal list
    "desktop_ui",       # toolsets.py:275  its own literal list
]

identity = {
    "core_list_id": id(CORE_LIST),
    "core_list_len": len(CORE_LIST),
    "shares_core_list_object": {
        name: (toolsets.TOOLSETS[name]["tools"] is CORE_LIST) for name in IDENTITY_PROBE_TOOLSETS
    },
    "tools_object_id": {
        name: id(toolsets.TOOLSETS[name]["tools"]) for name in IDENTITY_PROBE_TOOLSETS
    },
    "toolsets_sharing_core_object_count": sum(
        1 for ts_def in toolsets.TOOLSETS.values() if ts_def.get("tools") is CORE_LIST
    ),
    "toolsets_total": len(toolsets.TOOLSETS),
    "toolsets_sharing_core_object": sorted(
        name for name, ts_def in toolsets.TOOLSETS.items() if ts_def.get("tools") is CORE_LIST
    ),
}


# ---------------------------------------------------------------------------
# (B) / (C) / (D): each variant runs in its OWN process, so no variant can
#     contaminate another.  The sub-runs are invoked below in "main" mode.
# ---------------------------------------------------------------------------


def mutation_probe(apply: str) -> dict[str, Any]:
    """Measure one mutation variant against a freshly imported toolsets module.

    ``apply`` is "append" or "rebind"; both add PRODUCT_TOOL_NAMES to the core
    set, and differ only in HOW.  Everything is read before and after so the
    collateral question is answered by observation, not by reasoning.
    """
    before = {
        "core_len": len(toolsets._HERMES_CORE_TOOLS),
        "core_id": id(toolsets._HERMES_CORE_TOOLS),
        "hermes_cli_tools_len": len(toolsets.TOOLSETS["hermes-cli"]["tools"]),
        "hermes_cli_resolved_len": len(toolsets.resolve_toolset("hermes-cli")),
        "hermes_cli_has_product": sorted(
            set(toolsets.resolve_toolset("hermes-cli")) & set(PRODUCT_TOOL_NAMES)
        ),
        "hermes_telegram_has_product": sorted(
            set(toolsets.resolve_toolset("hermes-telegram")) & set(PRODUCT_TOOL_NAMES)
        ),
        "core_tool_names_sees_product": sorted(
            ts._core_tool_names() & frozenset(PRODUCT_TOOL_NAMES)
        ),
        "deferrable_count": len(ts.classify_tools(SEAT_TOOL_DEFS)[1]),
    }

    old = toolsets._HERMES_CORE_TOOLS
    if apply == "append":
        # Variant 1 — in-place mutation of the shared list object.
        for name in PRODUCT_TOOL_NAMES:
            toolsets._HERMES_CORE_TOOLS.append(name)
    elif apply == "rebind":
        # Variant 2 — bind the module attribute to a NEW list. The old object,
        # which TOOLSETS entries hold by reference, is left untouched.
        toolsets._HERMES_CORE_TOOLS = list(old) + list(PRODUCT_TOOL_NAMES)
    else:  # pragma: no cover - guarded by the caller
        raise ValueError(apply)

    visible_after, deferrable_after = ts.classify_tools(SEAT_TOOL_DEFS)
    assembly_after = ts.assemble_tool_defs(
        SEAT_TOOL_DEFS, context_length=CONTEXT_LENGTH, config=config
    )
    bridge_after = [
        td for td in assembly_after.tool_defs if td["function"]["name"] in ts.BRIDGE_TOOL_NAMES
    ]

    after = {
        "core_len": len(toolsets._HERMES_CORE_TOOLS),
        "core_id": id(toolsets._HERMES_CORE_TOOLS),
        "core_object_rebound": id(toolsets._HERMES_CORE_TOOLS) != before["core_id"],
        "hermes_cli_tools_len": len(toolsets.TOOLSETS["hermes-cli"]["tools"]),
        "hermes_cli_resolved_len": len(toolsets.resolve_toolset("hermes-cli")),
        "hermes_cli_has_product": sorted(
            set(toolsets.resolve_toolset("hermes-cli")) & set(PRODUCT_TOOL_NAMES)
        ),
        "hermes_telegram_has_product": sorted(
            set(toolsets.resolve_toolset("hermes-telegram")) & set(PRODUCT_TOOL_NAMES)
        ),
        "core_tool_names_sees_product": sorted(
            ts._core_tool_names() & frozenset(PRODUCT_TOOL_NAMES)
        ),
        "deferrable_count": len(deferrable_after),
        "deferrable_names": sorted(td["function"]["name"] for td in deferrable_after),
        "visible_count": len(visible_after),
        "assembly_activated": assembly_after.activated,
        "assembly_tier": assembly_after.tier,
        "assembly_listing_form": assembly_after.listing_form,
        "bridge_tools_in_array": sorted(td["function"]["name"] for td in bridge_after),
        "assembled_tool_count": len(assembly_after.tool_defs),
    }

    collateral = {
        "cli_toolset_changed": before["hermes_cli_resolved_len"] != after["hermes_cli_resolved_len"],
        "cli_leaked_product_tools": after["hermes_cli_has_product"],
        "telegram_leaked_product_tools": after["hermes_telegram_has_product"],
        "narrow_waist_intact": (
            after["hermes_cli_has_product"] == [] and after["hermes_telegram_has_product"] == []
        ),
    }

    # HAZARD 1 — bundle_non_core_tools(name) computes `set(tools) - core`.
    # After a rebind the core set is LARGER than the bundle's own list, so a
    # disabled bundle removes a different (possibly empty) delta. Measured, not
    # assumed. (toolsets.py:726-752, called from model_tools.py:441-449.)
    hazard_bundle = {
        "hermes_discord_non_core_delta": sorted(toolsets.bundle_non_core_tools("hermes-discord")),
        "desktop_ui_non_core_delta": sorted(toolsets.bundle_non_core_tools("desktop_ui")),
    }

    # HAZARD 2 — memory_manager rejects provider tools whose name is in the
    # core set (agent/memory_manager.py:437-439 and :792-794). A rebind widens
    # that reserved-name set by exactly the product names.
    hazard_reserved_names = {
        "reserved_core_name_count": len(set(toolsets._HERMES_CORE_TOOLS)),
        "product_names_now_reserved": sorted(
            set(toolsets._HERMES_CORE_TOOLS) & set(PRODUCT_TOOL_NAMES)
        ),
    }

    # HAZARD 3 — the auto-generated plugin-platform toolset in
    # toolsets.resolve_toolset (toolsets.py:805-822) builds
    # ``set(_HERMES_CORE_TOOLS)`` LAZILY at call time. Unlike the TOOLSETS
    # entries, it therefore CANNOT be protected by rebinding: it reads the new
    # binding. Measured for both variants.
    hazard_plugin_platform = {
        "resolved_len": len(toolsets.resolve_toolset(f"hermes-{FAKE_PLUGIN_PLATFORM}")),
        "leaked_product_tools": sorted(
            set(toolsets.resolve_toolset(f"hermes-{FAKE_PLUGIN_PLATFORM}"))
            & set(PRODUCT_TOOL_NAMES)
        ),
    }

    return {
        "variant": apply,
        "before": before,
        "after": after,
        "collateral": collateral,
        "hazard_bundle_non_core_tools": hazard_bundle,
        "hazard_reserved_tool_names": hazard_reserved_names,
        "hazard_plugin_platform_toolset": hazard_plugin_platform,
    }


# ---------------------------------------------------------------------------
# (D) 67 foreign MCP tools — the case the bridge was built for.
# ---------------------------------------------------------------------------


def foreign_mcp_tool(index: int) -> dict[str, Any]:
    """One realistically-sized third-party MCP tool schema.

    Sized against the real deferrable surface measured in "main" mode: the 11
    product tools average ~1064 chars of JSON each. These are built to land in
    the same order of magnitude so the 67-server case is not understated.
    """
    return {
        "name": f"fremd_tool_{index:02d}",
        "description": (
            f"Third-party MCP capability #{index}. Performs a bounded remote operation "
            "against the connected service and returns a structured result. Requires an "
            "explicit resource identifier and an operation mode; optional filters narrow "
            "the result set. Rate-limited server-side; retries are the caller's business."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "resource_id": {
                    "type": "string",
                    "description": (
                        "Identifier of the remote resource this operation addresses, in the "
                        "service's own canonical form."
                    ),
                },
                "mode": {
                    "type": "string",
                    "enum": ["read", "write", "sync", "audit"],
                    "description": "Which operation to perform against the resource.",
                },
                "filter": {
                    "type": "string",
                    "description": "Optional filter expression narrowing the returned records.",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 500,
                    "description": "Optional maximum number of records to return.",
                },
            },
            "required": ["resource_id", "mode"],
        },
    }


FOREIGN_MCP_COUNT = 67


def mcp_scale_probe(*, rebind: bool) -> dict[str, Any]:
    """Measure the seat plus 67 foreign MCP tools, with or without the rebind."""
    foreign = [foreign_mcp_tool(i) for i in range(FOREIGN_MCP_COUNT)]
    for tool in foreign:
        registry.register(name=tool["name"], toolset="mcp-fremd", schema=tool)
    defs = SEAT_TOOL_DEFS + [as_tool_def(t) for t in foreign]

    if rebind:
        toolsets._HERMES_CORE_TOOLS = list(toolsets._HERMES_CORE_TOOLS) + list(PRODUCT_TOOL_NAMES)

    _visible, deferrable_now = ts.classify_tools(defs)
    deferrable_now_names = sorted(td["function"]["name"] for td in deferrable_now)
    assembly_now = ts.assemble_tool_defs(defs, context_length=CONTEXT_LENGTH, config=config)
    bridge_now = [
        td for td in assembly_now.tool_defs if td["function"]["name"] in ts.BRIDGE_TOOL_NAMES
    ]
    visible_names = {td["function"]["name"] for td in assembly_now.tool_defs}

    return {
        "rebind_applied": rebind,
        "total_tools_offered": len(defs),
        "foreign_mcp_count": FOREIGN_MCP_COUNT,
        "deferrable_count": len(deferrable_now),
        "product_tools_still_deferrable": sorted(
            set(deferrable_now_names) & set(PRODUCT_TOOL_NAMES)
        ),
        "foreign_tools_deferrable": sum(
            1 for n in deferrable_now_names if n.startswith("fremd_tool_")
        ),
        "product_tools_eager_in_array": sorted(set(visible_names) & set(PRODUCT_TOOL_NAMES)),
        "activated": assembly_now.activated,
        "tier": assembly_now.tier,
        "listing_form": assembly_now.listing_form,
        "deferred_tokens": assembly_now.deferred_tokens,
        "bridge_tokens": ts.estimate_tokens_from_schemas(bridge_now),
        "bridge_tools_in_array": sorted(td["function"]["name"] for td in bridge_now),
        "assembled_tool_count": len(assembly_now.tool_defs),
        "eager_product_tokens": ts.estimate_tokens_from_schemas(
            [td for td in defs if td["function"]["name"] in set(PRODUCT_TOOL_NAMES)]
        ),
    }


def run_submode(mode: str) -> dict[str, Any]:
    """Run one measurement in a FRESH process and return its parsed JSON."""
    proc = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), str(WHEEL_PATH), mode],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return {"error": f"sub-run '{mode}' failed", "stderr": proc.stderr[-2000:]}
    return json.loads(proc.stdout)


# ---------------------------------------------------------------------------
# Mode dispatch
# ---------------------------------------------------------------------------

if MODE == "append":
    print(json.dumps(mutation_probe("append"), indent=2, ensure_ascii=False))
    sys.exit(0)

if MODE == "rebind":
    print(json.dumps(mutation_probe("rebind"), indent=2, ensure_ascii=False))
    sys.exit(0)

if MODE == "baseline_67mcp":
    print(json.dumps(mcp_scale_probe(rebind=False), indent=2, ensure_ascii=False))
    sys.exit(0)

if MODE == "rebind_67mcp":
    print(json.dumps(mcp_scale_probe(rebind=True), indent=2, ensure_ascii=False))
    sys.exit(0)


# ---------------------------------------------------------------------------

print(
    json.dumps(
        {
            "wheel": WHEEL_PATH.name,
            "classification": classification,
            "token_delta": token_delta,
            "tier_and_listing": tier_and_listing,
            "describe_enforcement": describe_enforcement,
            "core_list_identity": identity,
            "variant_1_append": run_submode("append"),
            "variant_2_rebind": run_submode("rebind"),
            "mcp_67_baseline": run_submode("baseline_67mcp"),
            "mcp_67_after_rebind": run_submode("rebind_67mcp"),
            "notes": [
                "toolsets.py and tools/tool_search.py are executed from the wheel, not transcribed.",
                "open_preview / focus_pane / read_terminal carry their REAL wheel schemas: "
                "importing their modules runs their own registry.register() calls.",
                "read_preview is transcribed verbatim from "
                "packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts:8836-8851.",
                "MCP descriptions are verbatim from eveArtifactToolSurface.ts:60-116 and "
                "imageGenServer.ts:70-133; their parameter shapes are reconstructed from the zod "
                "schemas in eveArtifactContextServer.ts:134-278 and imageGenServer.ts:110-133 "
                "(required = the non-.optional() fields), not captured off the MCP wire.",
                "The hermes-acp native tools carry a placeholder schema body. They classify as "
                "core (hermes_acp_all_core), so classification never reads their schema and their "
                "token cost is identical with and without the bridge. They are NOT part of the "
                "token delta, which counts only deferrable schemas.",
                "No provider, no network, no inference. The listing is byte-stable because "
                "tool_search sorts groups and tools.",
                "Each mutation variant runs in its OWN subprocess (run_submode), so an append "
                "can never contaminate the rebind measurement or the 67-MCP probes.",
                "The 67 foreign MCP schemas are synthetic but sized against the real deferrable "
                "surface; they stand in for third-party servers, not for a specific product.",
            ],
        },
        indent=2,
        ensure_ascii=False,
    )
)
