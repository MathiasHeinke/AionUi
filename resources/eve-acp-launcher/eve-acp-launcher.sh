#!/bin/sh
# Command EVE — eve-acp-launcher (SG-1 Design A, 1.7.0).
#
# The wheel's copilot_acp_client spawns this via subprocess.Popen with
# stdin/stdout/stderr=PIPE and speaks line-delimited JSON-RPC over stdin/stdout
# (FACT copilot_acp_client.py:433-437). This launcher sits transparently in
# front of the real Claude ACP adapter to:
#   1. PAUSE-GATE: refuse to spawn a paused/off role (exit 3). The Claude
#      delegate lane runs on the operator's own subscription and NEVER hits the
#      shim, so the shim's 409 gate cannot pause it — this launcher is the ONLY
#      enforcement point for the delegate lane.
#   2. TOKEN INJECT: export EVE_AGENT_ID + EVE_LEASE_TOKEN into the child env
#      (read from a 0600 file OUTSIDE hermesHome — NEVER passed in argv or model
#      input).
#   3. TRANSPARENT stdio: `exec` the real adapter so the process is REPLACED
#      (fds 0/1/2 inherited perfectly — the JSON-RPC pipe passes through
#      untouched). The launcher writes NOTHING to stdout, ever.
#
# Invocation (bound by the Desktop main process through trusted process env):
#   eve-acp-launcher.sh --role <agent_id> --status-file <path>
#     --token-file <path> -- <realAdapterCmd> [args...]
#
# POSIX sh only. No shell-specific arrays or node/bun launcher dependency.

set -eu

ROLE=""
STATUS_FILE=""
TOKEN_FILE=""
MCP_CONFIG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="${2:-}"; shift 2 ;;
    --status-file) STATUS_FILE="${2:-}"; shift 2 ;;
    --token-file) TOKEN_FILE="${2:-}"; shift 2 ;;
    --mcp-config) MCP_CONFIG="${2:-}"; shift 2 ;;
    --) shift; break ;;
    *) echo "eve-acp-launcher: unexpected arg: $1" >&2; exit 2 ;;
  esac
done

# Fatal errors go to STDERR only (stdout is the JSON-RPC channel) + non-zero
# exit so the wheel sees a failed spawn.
if [ -z "$ROLE" ]; then echo "eve-acp-launcher: missing --role" >&2; exit 2; fi
if [ $# -eq 0 ]; then echo "eve-acp-launcher: missing -- <realAdapterCmd>" >&2; exit 2; fi

# 1) Pause-gate. The main process maintains a per-role status file (active|
#    paused|off) and ALWAYS writes it when it wires this launcher (--status-file).
#    Reading a file (not an HTTP call) removes any dependency on shim readiness at
#    adapter-spawn time.
#
#    FAIL-CLOSED when a status file is EXPECTED (--status-file given) but missing or
#    unreadable: since main always writes it, an absent file here is anomalous — a
#    crash, a stray cleanup, or a same-user process deleting the file to defeat the
#    pause-gate (EVE-cloud audit: the status file lives at a discoverable path and
#    the delegate runs as the same OS user; a naive fail-open would let a deleted
#    file re-enable a paused role). A paused role must never be re-enabled by
#    REMOVING its control file. Fail-OPEN (active) applies ONLY when no status file
#    was configured at all (--status-file absent) — the availability default.
STATUS="active"
if [ -n "$STATUS_FILE" ]; then
  if [ -r "$STATUS_FILE" ]; then
    STATUS="$(cat "$STATUS_FILE" 2>/dev/null | tr -d '[:space:]')"
    [ -z "$STATUS" ] && STATUS="active"
  else
    echo "eve-acp-launcher: status file expected but unreadable ($STATUS_FILE) — refusing" >&2
    exit 3
  fi
fi
if [ "$STATUS" = "paused" ] || [ "$STATUS" = "off" ]; then
  echo "eve-acp-launcher: role $ROLE is $STATUS — refusing to spawn worker" >&2
  exit 3
fi

# 2) Token inject (env only — never argv/stdout).
TOKEN=""
if [ -n "$TOKEN_FILE" ] && [ -r "$TOKEN_FILE" ]; then
  TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null | tr -d '[:space:]')"
fi

# 3) Build the child environment from an allowlist. A denylist cannot anticipate
#    future provider keys, bearer names, or control-file paths. The adapter gets
#    only OS/runtime basics, its machine-local Claude login location, and the
#    scoped EVE role lease.

# 5) COMPA-624 — hand the delegate the per-seat honcho MEMORY tool. --mcp-config is
#    a FILE PATH (not a secret; the HONCHO_* values live inside the 0600 file, which
#    holds only a passwordless-loopback dbUri/workspace/home). Export it under the
#    adapter's MCP-config env var ONLY when the file is actually readable — an absent
#    file (Honcho not provisioned/ready) is a silent no-op, so the delegate simply
#    runs without a honcho tool. The env-var NAME is MAC-VERIFY-PENDING against the
#    installed claude-agent-acp adapter (see CLAUDE_DELEGATE_MCP_CONFIG_ENV).
CLAUDE_CONFIG="${CLAUDE_CONFIG_DIR:-}"
HAS_MCP_CONFIG="false"
if [ -n "$MCP_CONFIG" ] && [ -r "$MCP_CONFIG" ]; then
  HAS_MCP_CONFIG="true"
fi

# Build env(1)'s assignment argv before the adapter command. Optional variables
# stay absent when their parent value is empty; an empty HOME or
# CLAUDE_CONFIG_DIR is an explicit path for several runtimes and disables their
# normal account-directory fallback.
set -- \
  "PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}" \
  "TMPDIR=${TMPDIR:-/tmp}" \
  "LANG=${LANG:-en_US.UTF-8}" \
  "SHELL=${SHELL:-/bin/sh}" \
  "EVE_AGENT_ID=$ROLE" \
  "EVE_LEASE_TOKEN=$TOKEN" \
  "$@"

if [ -n "${LOGNAME:-}" ]; then set -- "LOGNAME=$LOGNAME" "$@"; fi
if [ -n "${USER:-}" ]; then set -- "USER=$USER" "$@"; fi
if [ -n "${HOME:-}" ]; then set -- "HOME=$HOME" "$@"; fi
if [ -n "$CLAUDE_CONFIG" ]; then set -- "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG" "$@"; fi
if [ "$HAS_MCP_CONFIG" = "true" ]; then set -- "CLAUDE_MCP_CONFIG=$MCP_CONFIG" "$@"; fi

exec env -i "$@"
