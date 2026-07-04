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
#      (read from a 0600 file OUTSIDE hermesHome — NEVER passed in argv/SOUL,
#      which is model-visible).
#   3. TRANSPARENT stdio: `exec` the real adapter so the process is REPLACED
#      (fds 0/1/2 inherited perfectly — the JSON-RPC pipe passes through
#      untouched). The launcher writes NOTHING to stdout, ever.
#
# Invocation (emitted by eveWorkerRoutingDirective):
#   eve-acp-launcher.sh --role <agent_id> --status-file <path>
#     --token-file <path> -- <realAdapterCmd> [args...]
#
# POSIX sh only (Command EVE is Apple-Silicon-macOS-only). No node/bun needed.

set -eu

ROLE=""
STATUS_FILE=""
TOKEN_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="${2:-}"; shift 2 ;;
    --status-file) STATUS_FILE="${2:-}"; shift 2 ;;
    --token-file) TOKEN_FILE="${2:-}"; shift 2 ;;
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

# 3) SCRUB operator-only state from the delegated worker's env. This launcher is
#    the boundary between EVE's runtime (which legitimately holds these) and a
#    third-party autonomous CLI worker (which must not). The delegate inherits our
#    full env via `exec`, so anything not unset here leaks to it. COMMAND_EVE_TEAM_
#    MANAGE_BEARER gates the team_manage propose route — a delegated worker holding
#    it could queue team-status-change intents EVE alone is meant to raise. The
#    status/token FILE PATHS are shell locals (not exported) and are consumed above,
#    so they are already absent from the child — we unset them anyway as defence in
#    depth so no future refactor can leak the pause-gate's control-file path to the
#    delegate. (The A4 lease token is delivered per-role, not a shared secret.)
unset COMMAND_EVE_TEAM_MANAGE_BEARER COMMAND_EVE_TEAM_MANAGE_BEARER_FILE STATUS_FILE TOKEN_FILE

# 4) Transparent stdio: `exec` replaces this process with the real adapter,
#    inheriting fds 0/1/2 exactly — the wheel's JSON-RPC pipe is untouched.
export EVE_AGENT_ID="$ROLE"
export EVE_LEASE_TOKEN="$TOKEN"
exec "$@"
