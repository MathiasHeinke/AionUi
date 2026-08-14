#!/usr/bin/env python3
"""Behavioral gate for the exact Hermes 0.20 Browser Use receipt patch."""

from __future__ import annotations

import ast
import hashlib
import inspect
import json
import logging
import os
import stat
import sys
import tempfile
import types
import zipfile
from pathlib import Path
from typing import Any


SOURCE_PATH = Path(sys.argv[1]).resolve()
WHEEL_PATH = Path(sys.argv[2]).resolve()


def load_patch() -> dict[str, Any]:
    tree = ast.parse(SOURCE_PATH.read_text(encoding="utf-8"), filename=str(SOURCE_PATH))
    wanted_functions = {
        "_command_eve_mark_patch",
        "_install_command_eve_browser_use_uvx_receipt_patch",
    }
    wanted_globals = {"_COMMAND_EVE_EXPECTED_PATCHES", "_COMMAND_EVE_INSTALLED_PATCHES"}
    body: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted_functions:
            body.append(node)
        elif isinstance(node, ast.Assign) and {
            target.id for target in node.targets if isinstance(target, ast.Name)
        } & wanted_globals:
            body.append(node)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id in wanted_globals:
            body.append(node)
    namespace: dict[str, Any] = {
        "Any": Any,
        "inspect": inspect,
        "logging": logging,
    }
    exec(compile(ast.fix_missing_locations(ast.Module(body=body, type_ignores=[])), str(SOURCE_PATH), "exec"), namespace)
    return namespace


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


with tempfile.TemporaryDirectory(prefix="command-eve-uvx-receipt-") as raw_root:
    root = Path(raw_root).resolve()
    wheel_root = root / "wheel"
    with zipfile.ZipFile(WHEEL_PATH) as archive:
        archive.extractall(wheel_root)
    sys.path.insert(0, str(wheel_root))
    utils = types.ModuleType("utils")
    utils.is_truthy_value = lambda value: str(value or "").strip().lower() in {"1", "true", "yes", "on"}
    sys.modules["utils"] = utils
    from tools import browser_use_cli

    original = browser_use_cli._find_command_eve_cli
    home = root / "hermes-home"
    runner_root = home / "bin"
    runner_root.mkdir(parents=True, mode=0o700)
    os.chmod(home, 0o700)
    os.chmod(runner_root, 0o700)
    runner = runner_root / "uvx"
    runner.write_bytes(b"#!/bin/sh\nexit 0\n")
    os.chmod(runner, 0o700)
    companion = runner_root / "uv"
    companion.write_bytes(b"#!/bin/sh\nexit 0\n")
    os.chmod(companion, 0o700)
    receipt_path = runner_root / "uvx-artifact-receipt.json"
    descriptor_path = home / "browser-use-runner.json"
    os.environ["HERMES_HOME"] = str(home)
    os.environ["COMMAND_EVE_BROWSER_UVX_PATH"] = str(runner)
    os.environ["COMMAND_EVE_BROWSER_UVX_DESCRIPTOR_PATH"] = str(descriptor_path)
    hermes_constants = types.ModuleType("hermes_constants")
    hermes_constants.get_hermes_home = lambda: home
    sys.modules["hermes_constants"] = hermes_constants

    def write_receipt(*, archive_entry: str, release_tag: str, provenance: str) -> None:
        receipt = {
            "schema_version": "command-eve-uvx-artifact-receipt/v1",
            "upstream": "astral-sh/uv",
            "version": "0.10.12",
            "target": "aarch64-apple-darwin",
            "archive_name": "uv-aarch64-apple-darwin.tar.gz",
            "archive_sha256": "a" * 64,
            "archive_entry": archive_entry,
            "runner_filename": "uvx",
            "source_runner_sha256": "b" * 64,
            "runner_sha256": sha256(runner),
            "companion_archive_entry": "uv-aarch64-apple-darwin/uv",
            "companion_filename": "uv",
            "companion_source_sha256": "c" * 64,
            "companion_sha256": sha256(companion),
            "provenance": provenance,
            "attestation": {"repo": "astral-sh/uv", "release_tag": release_tag},
            "signing": {
                "authority": "Developer ID Application: FYN Labs LLC (NHNQ7Q5H28)",
                "team_id": "NHNQ7Q5H28",
                "identifier": "uvx",
                "hardened_runtime": True,
            },
            "companion_signing": {
                "authority": "Developer ID Application: FYN Labs LLC (NHNQ7Q5H28)",
                "team_id": "NHNQ7Q5H28",
                "identifier": "uv",
                "hardened_runtime": True,
            },
        }
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        os.chmod(receipt_path, 0o600)
        descriptor = {
            "schema_version": "command-eve-browser-use-runner/v1",
            "hermes_home": str(home),
            "path": str(runner),
            "root": str(runner_root),
            "artifact_receipt_path": str(receipt_path),
            "sha256": sha256(runner),
            "companion_path": str(companion),
            "companion_sha256": sha256(companion),
            "version": "0.10.12",
            "target": "aarch64-apple-darwin",
            "artifact_receipt_sha256": sha256(receipt_path),
            "provenance": "packaged-astral-uvx/v1",
        }
        descriptor_path.write_text(json.dumps(descriptor), encoding="utf-8")
        os.chmod(descriptor_path, 0o600)

    write_receipt(
        archive_entry="uv-aarch64-apple-darwin/uvx",
        release_tag="0.10.12",
        provenance="official-astral-release-attestation+fynlabs-developer-id/v1",
    )
    assert original() is None

    namespace = load_patch()
    install = namespace["_install_command_eve_browser_use_uvx_receipt_patch"]
    install()
    patched = browser_use_cli._find_command_eve_cli
    install()
    assert patched is browser_use_cli._find_command_eve_cli
    traced_lines: list[int] = []
    def trace_patch(frame: types.FrameType, event: str, _arg: Any):
        if frame.f_code is patched.__code__ and event == "line":
            traced_lines.append(frame.f_lineno)
        return trace_patch
    sys.settrace(trace_patch)
    patched_result = patched()
    sys.settrace(None)
    if patched_result is None:
        print(f"patched uvx resolver returned None; trace={traced_lines[-20:]}", file=sys.stderr)
    assert patched_result == [
        str(runner),
        "--with",
        browser_use_cli.BROWSER_HARNESS_UVX_SPEC,
        browser_use_cli.BROWSER_USE_UVX_SPEC,
    ]

    companion.write_bytes(b"tampered\n")
    os.chmod(companion, 0o700)
    assert patched() is None
    companion.unlink()
    assert patched() is None
    companion.symlink_to(runner)
    assert patched() is None
    companion.unlink()
    companion.write_bytes(b"#!/bin/sh\nexit 0\n")
    os.chmod(companion, 0o755)
    write_receipt(
        archive_entry="uv-aarch64-apple-darwin/uvx",
        release_tag="0.10.12",
        provenance="official-astral-release-attestation+fynlabs-developer-id/v1",
    )
    assert patched() is None
    os.chmod(companion, 0o700)
    write_receipt(
        archive_entry="uv-aarch64-apple-darwin/uvx",
        release_tag="0.10.12",
        provenance="official-astral-release-attestation+fynlabs-developer-id/v1",
    )
    assert patched() == [
        str(runner),
        "--with",
        browser_use_cli.BROWSER_HARNESS_UVX_SPEC,
        browser_use_cli.BROWSER_USE_UVX_SPEC,
    ]

    write_receipt(
        archive_entry="uvx",
        release_tag="0.10.12",
        provenance="official-astral-release-attestation+fynlabs-developer-id/v1",
    )
    assert patched() is None
    write_receipt(
        archive_entry="uv-aarch64-apple-darwin/uvx",
        release_tag="v0.10.12",
        provenance="official-astral-release-attestation+fynlabs-developer-id/v1",
    )
    assert patched() is None
    write_receipt(
        archive_entry="uv-aarch64-apple-darwin/uvx",
        release_tag="0.10.12",
        provenance="official-astral-release-attestation/v1",
    )
    assert patched() is None

    print(
        json.dumps(
            {
                "truthful_receipt_accepted": True,
                "old_flattened_entry_rejected": True,
                "old_prefixed_tag_rejected": True,
                "unsigned_provenance_rejected": True,
                "missing_companion_rejected": True,
                "tampered_companion_rejected": True,
                "symlinked_companion_rejected": True,
                "nonprivate_companion_rejected": True,
                "idempotent_install": True,
                "ledger_marked": "browser_use_uvx_receipt" in namespace["_COMMAND_EVE_INSTALLED_PATCHES"],
            }
        )
    )
