# eve-acp-launcher (SG-1 Design A, 1.7.0)

The transparent ACP-adapter wrapper that gives the Claude delegate lane a real
pause-gate + role attribution env, without touching the bundled wheel.

## Why a POSIX shell script (not node/bun)

Command EVE is Apple-Silicon-macOS-only. There is NO bundled node/bun in
`resources/` (electron-builder bundles only CPython + aioncore-bun). A POSIX
`sh` script needs no bundled interpreter and `exec` replaces the process image,
inheriting fds 0/1/2 perfectly — the wheel's line-delimited JSON-RPC pipe
(`copilot_acp_client.py:433-437`, `stdin/stdout/stderr=PIPE`) passes through
untouched. Verified by the kill-switch probe (see EVAL-RECEIPTS §SG-1 A8).

## How the wheel spawns it

`delegate_task` → `subprocess.Popen([acp_command] + acp_args, ...)`. The routing
directive emits `acp_command = <this script>`, `acp_args = ['--role', <agent_id>,
'--status-file', <path>, '--token-file', <path>, '--', <realAdapterCmd>, ...]`.

## Gates it satisfies

- **A3 (Spawn-Pause):** refuses `exec` (exit 3) when the per-role status file is
  `paused`/`off` — the ONLY enforcement point for the delegate lane, which runs
  on the operator's subscription and never hits the shim's 409 gate.
- **A4 (Token-Sichtbarkeit):** the lease token is read from a 0600 file OUTSIDE
  hermesHome; it is NEVER in `acp_args` (which are model-visible in SOUL).
- **A8 (Kill-Switch):** stdio passthrough proven (see receipt).

## Remaining wiring (SG-1 Design A, not yet done — see progress note)

This artifact is built + proven but NOT YET wired in. To make it live:

1. `resolveWorkerRouting` (eveWorkerAssignmentCore.ts:270-272) / the
   directive-emission path (index.ts `resolveCommandEveWorkerRuntimeInputs` +
   commandEveBridge switch-resolver): wrap the resolved `acpCommand/acpArgs`
   with this launcher + main-resolved paths (launcher path via
   `process.resourcesPath`, status-dir + token-file under `getDataPath()`,
   OUTSIDE hermesHome). The launcher path is machine-specific → the wrap happens
   in the MAIN process, not the pure `resolveWorkerRouting`.
2. Main process writes the per-role status file whenever
   `commandEve.teamWorkerStatus` changes AND at boot (so the launcher reads live
   status). Single-writer discipline: the status file is a DERIVED read-mirror
   of the backend store, never a second source of truth.
3. Shim spoof-close (A1): strip `body.agent_id` in `ollamaOpenAiShim.ts:694`;
   resolve agent_id only from a validated `x-eve-dispatch` header via
   `eveAgentTaskRegistry` (forward-compat — the header producer is the 1.8 wheel
   bump; in 1.7.0 the shim's 409 stays dead-but-harmless, the launcher is the
   live pause enforcement).
