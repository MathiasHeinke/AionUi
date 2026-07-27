#!/usr/bin/env python3
"""Behavioral gate for Command EVE's generated bounded compression provider."""

from __future__ import annotations

import ast
import json
import os
import stat
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


PROVIDER_PATH = Path(sys.argv[1]).resolve()
SOURCE = PROVIDER_PATH.read_text(encoding="utf-8")


def load_selected_provider_symbols() -> dict[str, object]:
    tree = ast.parse(SOURCE, filename=str(PROVIDER_PATH))
    selected_names = {
        "_command_eve_shim_token",
        "_command_eve_is_local_shim_base",
        "_command_eve_compression_http_call",
        "_command_eve_write_compression_receipt",
        "_command_eve_start_compression_status",
        "_command_eve_complete_compression_status",
    }
    selected_globals = {
        "_COMMAND_EVE_COMPRESSION_ATTEMPT_TIMEOUT_S",
        "_COMMAND_EVE_COMPRESSION_MAX_ATTEMPTS",
        "_COMMAND_EVE_COMPRESSION_TOTAL_BUDGET_S",
        "_command_eve_compression_state",
    }
    allowed_imports = {"http.client", "json", "os", "re", "threading", "time"}
    allowed_from = {"pathlib", "types", "typing", "urllib.parse", "__future__"}
    body: list[ast.stmt] = []
    for node in tree.body:
        if isinstance(node, ast.Import) and all(alias.name in allowed_imports for alias in node.names):
            body.append(node)
        elif isinstance(node, ast.ImportFrom) and node.module in allowed_from:
            body.append(node)
        elif isinstance(node, ast.Assign):
            targets = {target.id for target in node.targets if isinstance(target, ast.Name)}
            if targets & selected_globals:
                body.append(node)
        elif isinstance(node, ast.ClassDef) and node.name == "_CommandEveCompressionRequestError":
            body.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name in selected_names:
            body.append(node)
    module = ast.fix_missing_locations(ast.Module(body=body, type_ignores=[]))
    namespace: dict[str, object] = {}
    exec(compile(module, str(PROVIDER_PATH), "exec"), namespace)
    return namespace


NAMESPACE = load_selected_provider_symbols()
strict_loopback_check = NAMESPACE["_command_eve_is_local_shim_base"]
assert strict_loopback_check("http://127.0.0.1:25811/v1") is True
assert strict_loopback_check("https://example.invalid/v1") is False
# Production remains pinned to 25811. The harness uses an OS-assigned loopback
# port so it cannot collide with a running Command EVE instance.
NAMESPACE["_command_eve_is_local_shim_base"] = lambda value: (
    (parsed := urlparse(str(value or ""))).scheme == "http"
    and (parsed.hostname or "").lower() in {"127.0.0.1", "localhost", "::1"}
    and parsed.path.rstrip("/") in {"", "/v1"}
)
NAMESPACE["_COMMAND_EVE_COMPRESSION_ATTEMPT_TIMEOUT_S"] = 0.15
NAMESPACE["_COMMAND_EVE_COMPRESSION_MAX_ATTEMPTS"] = 2
NAMESPACE["_COMMAND_EVE_COMPRESSION_TOTAL_BUDGET_S"] = 0.45


class ScenarioServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, responses: list[int], delay: float = 0.0):
        self.responses = list(responses)
        self.delay = delay
        self.attempts = 0
        super().__init__(("127.0.0.1", 0), ScenarioHandler)


class ScenarioHandler(BaseHTTPRequestHandler):
    server: ScenarioServer

    def do_POST(self) -> None:  # noqa: N802
        self.server.attempts += 1
        length = int(self.headers.get("content-length", "0"))
        if length:
            self.rfile.read(length)
        if self.server.delay:
            time.sleep(self.server.delay)
        status = self.server.responses[min(self.server.attempts - 1, len(self.server.responses) - 1)]
        body = (
            {"choices": [{"message": {"content": "bounded summary"}}]}
            if status == 200
            else {"error": {"message": "test failure"}}
        )
        encoded = json.dumps(body).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.send_header("x-command-eve-inference-lane", "ollama_local")
            self.send_header("x-command-eve-egress-decision", "allow")
            self.end_headers()
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, _format: str, *_args: object) -> None:
        return


def call_against(server: ScenarioServer) -> object:
    token_path = Path(tempfile.mkdtemp()) / "shim-token"
    token_path.write_text("a" * 64, encoding="utf-8")
    os.environ["COMMAND_EVE_SHIM_AUTH_TOKEN_FILE"] = str(token_path)
    return NAMESPACE["_command_eve_compression_http_call"](
        task="compression",
        main_runtime={
            "base_url": f"http://127.0.0.1:{server.server_port}/v1",
            "model": "command-eve-test",
        },
        messages=[{"role": "user", "content": "summarize"}],
        max_tokens=128,
    )


def run_server_case(responses: list[int], *, delay: float = 0.0) -> tuple[object | None, Exception | None, int, float]:
    server = ScenarioServer(responses, delay=delay)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    started = time.monotonic()
    value: object | None = None
    error: Exception | None = None
    try:
        value = call_against(server)
    except Exception as caught:
        error = caught
    elapsed = time.monotonic() - started
    server.shutdown()
    server.server_close()
    thread.join(timeout=1)
    return value, error, server.attempts, elapsed


retry_value, retry_error, retry_attempts, _ = run_server_case([500, 200])
assert retry_error is None, repr(retry_error)
assert retry_attempts == 2
assert retry_value.choices[0].message.content == "bounded summary"
assert NAMESPACE["_command_eve_compression_state"].effective_lane == "ollama_local"

_, nonretry_error, nonretry_attempts, _ = run_server_case([401])
assert nonretry_error is not None
assert nonretry_attempts == 1

_, timeout_error, timeout_attempts, timeout_elapsed = run_server_case([200], delay=0.5)
assert timeout_error is not None
assert timeout_attempts == 2
assert timeout_elapsed < 0.6

original_connection = NAMESPACE["http"].client.HTTPConnection


class InterruptConnection:
    def __init__(self, *_args: object, **_kwargs: object):
        pass

    def request(self, *_args: object, **_kwargs: object) -> None:
        raise KeyboardInterrupt()

    def close(self) -> None:
        pass


NAMESPACE["http"].client.HTTPConnection = InterruptConnection
NAMESPACE["_command_eve_compression_state"].attempts = 0
try:
    try:
        NAMESPACE["_command_eve_compression_http_call"](
            task="compression",
            main_runtime={"base_url": "http://127.0.0.1:25811/v1", "model": "test"},
            messages=[],
        )
        raise AssertionError("KeyboardInterrupt must escape")
    except KeyboardInterrupt:
        pass
    assert NAMESPACE["_command_eve_compression_state"].attempts == 1
finally:
    NAMESPACE["http"].client.HTTPConnection = original_connection

events: list[tuple[str, tuple[object, ...]]] = []


class FakeAgent:
    def tool_progress_callback(self, *args: object) -> None:
        events.append(("tool", args))

    def step_callback(self, *args: object) -> None:
        events.append(("step", args))

    def stream_delta_callback(self, *args: object) -> None:
        events.append(("stream", args))


receipt = {
    "version": "command-eve-compression-receipt/v1",
    "estimated_before_tokens": 200_000,
    "estimated_after_tokens": 98_000,
    "effective_lane": "ollama_local",
}
agent = FakeAgent()
NAMESPACE["_command_eve_start_compression_status"](agent, 200_000)
NAMESPACE["_command_eve_complete_compression_status"](agent, receipt, failed=False)
assert [kind for kind, _ in events] == ["tool", "step"]
assert events[0][1][1] == "context_compression"

with tempfile.TemporaryDirectory() as receipt_home:
    os.environ["HERMES_HOME"] = receipt_home
    NAMESPACE["_command_eve_write_compression_receipt"](receipt)
    receipt_path = Path(receipt_home) / "command-eve-compression-receipt.json"
    assert json.loads(receipt_path.read_text(encoding="utf-8")) == receipt
    assert stat.S_IMODE(receipt_path.stat().st_mode) == 0o600

print(
    json.dumps(
        {
            "retry_attempts": retry_attempts,
            "nonretry_attempts": nonretry_attempts,
            "timeout_attempts": timeout_attempts,
            "timeout_elapsed_ms": round(timeout_elapsed * 1000),
            "effective_lane": "ollama_local",
            "status_events": [kind for kind, _ in events],
            "receipt_mode": "0600",
        }
    )
)
