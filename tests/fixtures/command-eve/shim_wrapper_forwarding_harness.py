#!/usr/bin/env python3
"""Structural report on the emitted shim's monkeypatch wrappers.

G3 (CEVE-18205). The shim replaces Hermes methods at runtime. A replacement that
WRAPS the original inherits that original's calling convention, so it survives an
upstream signature change only if it forwards `*args, **kwargs` blindly. Hermes 0.20
changed four wrapped signatures (clear_interrupt, interrupt, run_conversation,
_compress_context); the wrappers that absorbed it did so because they forward, not
because anyone required them to.

This harness classifies every replacement and prints the facts. It does not judge —
the contract lives in the TS test, so the allowlist and its justification sit next to
the assertion instead of being buried in a fixture.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

PROVIDER_PATH = Path(sys.argv[1]).resolve()
SOURCE = PROVIDER_PATH.read_text(encoding="utf-8")

# The Hermes objects the shim monkeypatches. An assignment onto one of these is a
# replacement of production behaviour.
HOSTS = {
    "AIAgent",
    "HermesACPAgent",
    "ContextCompressor",
    "SessionManager",
    "auxiliary_client",
    "title_generator",
    "context_compressor",
    "acp_session_mod",
    "_ce_agent",
}


def is_original_name(name: str) -> bool:
    """A local holding the pre-patch callable, by the shim's naming convention."""
    return "original" in name or name in {"_current", "_original"}


def main() -> None:
    tree = ast.parse(SOURCE, filename=str(PROVIDER_PATH))

    replacements: dict[str, str] = {}
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Assign) and len(node.targets) == 1):
            continue
        target = node.targets[0]
        if (
            isinstance(target, ast.Attribute)
            and isinstance(target.value, ast.Name)
            and target.value.id in HOSTS
            and isinstance(node.value, ast.Name)
        ):
            replacements[node.value.id] = f"{target.value.id}.{target.attr}"

    functions = {
        node.name: node
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }

    report = []
    for fn_name, patch_target in sorted(replacements.items()):
        fn = functions.get(fn_name)
        if fn is None:
            report.append({"function": fn_name, "target": patch_target, "resolved": False})
            continue

        declares_args = fn.args.vararg is not None
        declares_kwargs = fn.args.kwarg is not None

        wraps_original = False
        forwards_args = False
        forwards_kwargs = False
        for call in ast.walk(fn):
            if not (isinstance(call, ast.Call) and isinstance(call.func, ast.Name)):
                continue
            if not is_original_name(call.func.id):
                continue
            wraps_original = True
            if fn.args.vararg is not None and any(
                isinstance(a, ast.Starred)
                and isinstance(a.value, ast.Name)
                and a.value.id == fn.args.vararg.arg
                for a in call.args
            ):
                forwards_args = True
            if fn.args.kwarg is not None and any(
                kw.arg is None and isinstance(kw.value, ast.Name) and kw.value.id == fn.args.kwarg.arg
                for kw in call.keywords
            ):
                forwards_kwargs = True

        report.append(
            {
                "function": fn_name,
                "target": patch_target,
                "resolved": True,
                "wraps_original": wraps_original,
                "declares_args": declares_args,
                "declares_kwargs": declares_kwargs,
                "forwards_args": forwards_args,
                "forwards_kwargs": forwards_kwargs,
            }
        )

    # Every place that reasons about a wrapped callable's ARITY. Each one is a hard
    # coupling to an upstream signature and must be justified individually.
    arity_sites = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr == "signature" and getattr(node.func.value, "id", "") == "inspect":
                enclosing = "<module>"
                for candidate in ast.walk(tree):
                    if isinstance(candidate, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        if candidate.lineno <= node.lineno <= (candidate.end_lineno or node.lineno):
                            enclosing = candidate.name
                arity_sites.append({"kind": "inspect.signature", "enclosing": enclosing})

    print(json.dumps({"replacements": report, "arity_sites": arity_sites}, sort_keys=True))


main()
