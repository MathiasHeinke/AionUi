#!/usr/bin/env python3
"""Provider-free classification proof for the exact bundled Hermes 0.20 wheel.

This deliberately performs no provider request. It executes an OpenAI 2.24
client call through the exact Hermes 0.20 primary-client factory against a
loopback server, and proves the 422 shim refusal produces exactly one HTTP
attempt. It also checks the exact wheel's outer 4xx classifier and its empty
fallback-chain guard; the emitted Command EVE config separately has no main
fallback_model or fallback_providers.
"""

from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
import threading
import types
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace


WHEEL_PATH = Path(sys.argv[1]).resolve()
SHIM_BASE_URL = sys.argv[2].rstrip("/") if len(sys.argv) > 2 else ""
SHIM_AUTH_TOKEN = sys.argv[3] if len(sys.argv) > 3 else ""


def reexec_with_bundled_runtime() -> None:
    """Use the already-installed Command EVE SDK; never install or contact a provider."""
    if os.environ.get("COMMAND_EVE_MANAGED_VISUAL_HARNESS_CHILD") == "1":
        return
    candidates = (
        Path.home()
        / "Library/Application Support/Command EVE/command-eve/command-eve-runtime/hermes/venv/bin/python3",
        Path.home() / "Library/Application Support/AionUi/aionui/command-eve-runtime/hermes/venv/bin/python3",
    )
    python = next((path for path in candidates if path.is_file()), None)
    if python is None:
        raise SystemExit("exact Command EVE Hermes/OpenAI runtime is unavailable")
    env = dict(os.environ)
    env["COMMAND_EVE_MANAGED_VISUAL_HARNESS_CHILD"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    result = subprocess.run([str(python), str(Path(__file__).resolve()), *sys.argv[1:]], env=env, text=True)
    raise SystemExit(result.returncode)


reexec_with_bundled_runtime()

import httpx  # noqa: E402
import openai  # noqa: E402


def extract_exact_wheel_client_factory():
    with zipfile.ZipFile(WHEEL_PATH) as wheel:
        source = wheel.read("agent/agent_runtime_helpers.py").decode("utf-8")
    tree = ast.parse(source, filename=f"{WHEEL_PATH}!agent/agent_runtime_helpers.py")
    function = next(
        node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "create_openai_client"
    )
    module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
    auxiliary_client = types.ModuleType("agent.auxiliary_client")
    auxiliary_client._validate_base_url = lambda _base_url: None
    auxiliary_client._validate_proxy_env_urls = lambda: None
    ssl_verify = types.ModuleType("agent.ssl_verify")
    ssl_verify.resolve_httpx_verify = lambda **_kwargs: True
    sys.modules["agent.auxiliary_client"] = auxiliary_client
    sys.modules["agent.ssl_verify"] = ssl_verify
    namespace = {
        "Any": object,
        "base_url_host_matches": lambda *_args: False,
        "_ra": lambda: SimpleNamespace(
            OpenAI=__import__("openai").OpenAI,
            logger=SimpleNamespace(info=lambda *_args, **_kwargs: None),
        ),
    }
    exec(compile(module, f"{WHEEL_PATH}!agent/agent_runtime_helpers.py", "exec"), namespace)
    return namespace["create_openai_client"]


def verify_exact_wheel_outer_refusal_contract() -> dict[str, bool]:
    """Static source proof for the wheel's outer retry/fallback decision only."""
    with zipfile.ZipFile(WHEEL_PATH) as wheel:
        classifier_source = wheel.read("agent/error_classifier.py").decode("utf-8")
        conversation_source = wheel.read("agent/conversation_loop.py").decode("utf-8")
        fallback_source = wheel.read("agent/chat_completion_helpers.py").decode("utf-8")
        initialization_source = wheel.read("agent/agent_init.py").decode("utf-8")

    classifier_422_nonretryable = (
        "if 400 <= status_code < 500:" in classifier_source
        and "retryable=False" in classifier_source.split("if 400 <= status_code < 500:", 1)[1][:320]
    )
    outer_client_error_region = conversation_source.split("if is_client_error:", 1)[1][:3600]
    outer_loop_checks_pending_chain = (
        "if agent._has_pending_fallback():" in outer_client_error_region
        and "if agent._try_activate_fallback():" in outer_client_error_region
    )
    activation_refuses_empty_chain = (
        "if agent._fallback_index >= len(agent._fallback_chain):" in fallback_source
        and "return False" in fallback_source.split("if agent._fallback_index >= len(agent._fallback_chain):", 1)[1][:900]
    )
    missing_fallback_initializes_empty_chain = "agent._fallback_chain = []" in initialization_source
    assert classifier_422_nonretryable
    assert outer_loop_checks_pending_chain
    assert activation_refuses_empty_chain
    assert missing_fallback_initializes_empty_chain
    return {
        "wheel_422_classifier_nonretryable": classifier_422_nonretryable,
        "wheel_outer_loop_checks_pending_fallback": outer_loop_checks_pending_chain,
        "wheel_fallback_activation_refuses_empty_chain": activation_refuses_empty_chain,
        "wheel_missing_fallback_initializes_empty_chain": missing_fallback_initializes_empty_chain,
    }


outer_refusal_contract = verify_exact_wheel_outer_refusal_contract()


class RefusalHandler(BaseHTTPRequestHandler):
    attempts = 0

    def do_POST(self):  # noqa: N802
        type(self).attempts += 1
        size = int(self.headers.get("content-length", "0"))
        self.rfile.read(size)
        payload = {
            "error": {
                "message": "Managed visual authorization cannot be verified. Reattach the files and retry.",
                "type": "command_eve_managed_visual_authorization_error",
                "code": "EVE_MANAGED_VISUAL_AUTHORIZATION_INVALID",
            }
        }
        body = json.dumps(payload).encode("utf-8")
        self.send_response(422)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


default_client = openai.OpenAI(api_key="test-only")
try:
    retry_probe_request = httpx.Request("POST", "http://127.0.0.1/v1/chat/completions")
    assert default_client._should_retry(httpx.Response(409, request=retry_probe_request)) is True
    assert default_client._should_retry(httpx.Response(422, request=retry_probe_request)) is False
finally:
    default_client.close()

server = None
if SHIM_BASE_URL:
    target_base_url = SHIM_BASE_URL
    # The SDK owns Authorization and overrides a same-named default header, so
    # give it the shim nonce as its API key rather than relying on header merge
    # precedence. The nonce is test-local and never printed.
    api_key = SHIM_AUTH_TOKEN
else:
    server = ThreadingHTTPServer(("127.0.0.1", 0), RefusalHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    target_base_url = f"http://127.0.0.1:{server.server_port}/v1"
    api_key = "test-only"

try:
    create_openai_client = extract_exact_wheel_client_factory()
    agent = SimpleNamespace(
        provider="custom",
        _build_keepalive_http_client=lambda *_args, **_kwargs: None,
        _client_log_context=lambda: "provider-free-harness",
    )
    client = create_openai_client(
        agent,
        {"api_key": api_key, "base_url": target_base_url},
        reason="managed_visual_refusal_harness",
        shared=False,
    )
    assert client.max_retries == 0
    try:
        client.chat.completions.create(
            model="command-eve-managed",
            messages=[{"role": "user", "content": "provider-free test"}],
            extra_body={"eve_operation": "user_chat_turn"},
        )
    except Exception as error:
        assert getattr(error, "status_code", None) == 422
    else:
        raise AssertionError("422 refusal unexpectedly succeeded")
finally:
    if server is not None:
        server.shutdown()
        server.server_close()

if server is not None:
    assert RefusalHandler.attempts == 1
print(
    json.dumps(
        {
            "exact_wheel_primary_client_factory_executed": True,
            "openai_sdk_version": openai.__version__,
            "sdk_default_retries_409": True,
            "sdk_default_retries_422": False,
            "openai_sdk_max_retries": client.max_retries,
            "http_status": 422,
            "total_shim_http_attempts": RefusalHandler.attempts if server is not None else None,
            "target": "actual_loopback_shim" if SHIM_BASE_URL else "standalone_loopback",
            **outer_refusal_contract,
        }
    )
)
