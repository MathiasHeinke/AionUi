# eve-acp-launcher (SG-1 Design A, 1.7.0)

The platform ACP-adapter boundary that gives Command EVE's private specialist
lane a real pause gate, role attribution, and bounded process containment
without touching the bundled Hermes wheel.

## Platform implementations

- `eve-acp-launcher.sh`: macOS/POSIX. `/bin/sh` needs no bundled runtime and
  `exec` replaces the launcher with the adapter while preserving stdio.
- `eve-acp-launcher.ps1`: Windows 11. Windows PowerShell 5.1 is part of the OS.
  The proxy rewrites the ACP filesystem capability to read-only, rejects write
  requests, scrubs application credentials, enforces a bounded runtime, and
  places the complete adapter tree in a kill-on-close Windows Job Object.

## How the wheel spawns it

The security-backported Hermes wheel removes ACP command/argv from the
model-facing `delegate_task` schema. The main process resolves the platform
launcher and binds its file paths, stable role id, bounded timeout, and adapter
tuple through Desktop-owned `HERMES_COPILOT_ACP_*` process env. Hermes resolves
that transport only for the fixed `copilot-acp` provider. Lease bytes never
appear in argv or model input.

In a packaged app, Desktop resolves the exact `claude-agent-acp@0.39.0`
entrypoint and Node executable from AionCore's signed managed-resource bundle.
The packaged Windows lane therefore has no ambient Node, Bun, npm, or PATH
installation prerequisite. A present but malformed managed-resource bundle
fails closed; the pinned `bunx` tuple remains a development-only fallback for
source runs where no packaged bundle exists.

## Gates it satisfies

- **A3 (Spawn-Pause):** refuses to start when the per-role status file is not
  exactly `active` (exit 3 on Windows; paused/off on POSIX).
- **A4 (Token-Sichtbarkeit):** the lease token is read from a 0600 file OUTSIDE
  hermesHome; it is NEVER in argv or model input.
- **A4 (Environment boundary):** both launchers create the adapter environment
  from an allowlist, so future provider keys are not delegated merely because
  their names were unknown when this boundary was written.
- **WIN-B09 (Read-only):** Windows advertises no write capability and intercepts
  ACP filesystem mutation requests before Hermes can execute them. Session
  creation also replaces the adapter's own tool surface with `Read`, `Glob`,
  and `Grep`, disables user/project/local settings, strips MCP servers and extra
  roots, and rejects shell/write/task tools even when the caller requests them.
- **WIN-B09 (Timeout):** Windows has a two-hour default ceiling, clamped to
  60 seconds through 24 hours for explicit test/diagnostic overrides.
- **WIN-B09 (Orphan cleanup):** closing or killing the launcher closes its Job
  Object and terminates the entire adapter process tree.

## Verification

- Cross-platform source/contract tests:
  `tests/unit/command-eve/eveWorkerLauncherCore.test.ts` and
  `tests/unit/command-eve/eveAcpLauncherExec.test.ts`.
- Windows-only execution proof:
  `tests/unit/command-eve/eveAcpLauncherWindowsExec.test.ts`.
- The Windows execution proof must run on the private Windows 11 x64 candidate;
  a macOS skip is expected and is not accepted as WIN-B09 evidence.
