# Honcho Inc.3 — the single Mac residual (turnkey)

**Stand 2026-07-05.** The Honcho CONSUMPTION wiring is shipped + verified headless (O3 deriver
cloud route · MCP-server + SOUL render · fail-safe provisioning adapter). Everything is
byte-identical-until-ready + fully unit-tested. What remains **cannot** be verified headless
because there is no `honcho`/`postgres` in CI — it needs one run on the founder's Mac against
the live `honcho-ai` wheel. This doc makes that run turnkey.

## What is already done (no Mac needed)

- `honchoDeriverRouteCore` + shim injection (O3): the cloud-flash deriver lane activates the
  instant a seat has a fresh-ready readiness file. Money invariant intact (free tier forced,
  license header-only, no tier in route). Commit `68e1fd55`.
- `honchoRuntimeRenderCore` + `writeHermesRuntimeFiles` splice (O2/O5): when a seat is
  fresh-ready + a venv launcher exists, `config.yaml` advertises the `honcho` MCP server
  (per-seat, secret-free, canonical-loopback dbUri) and `SOUL.md` gains the durable-memory
  clause. Un-provisioned seats are byte-identical. Commit `6fcc50f2`.
- `runHonchoProvisioningForSeat` adapter + `commandEve.honchoMemoryOptIn` consent key: drives
  the fail-safe `runHonchoBootstrap`. Never blocks boot, never throws, no-op when disabled.
  Commit `328cd283`.

## The residual — 3 concrete steps on the Mac

### 1. Verify the command STRINGS (`buildHonchoCommandSet`, honchoProvisioningRun.ts)

These are drafted from FACT (step order + venv/db targets) but the exact invocations are
**MAC-VERIFY-PENDING**. Run each by hand once and correct the literal if it differs:

- `brew --version` (presence) · `brew install postgresql@16` · `brew install pgvector`
- `<hermesVenv>/bin/python --version` · `<hermesVenv>/bin/pip install honcho-ai`
- `createdb honcho_<hash>` (+ `CREATE EXTENSION vector` — confirm whether honcho does this itself)
- `<hermesVenv>/bin/python -m honcho serve` — confirm the real serve subcommand + flags
  (port, `--db-url`, deriver base_url env). Also confirm the MCP entry `python -m honcho.mcp`
  (in `honchoRuntimeRenderCore.HONCHO_MCP_ENTRY_ARGS`).
  Confirm the honcho SERVER endpoint (host:port) the honcho-ai client connects to, and whether
  the MCP server needs it in env (today the MCP env carries `HONCHO_DB_URI`/`WORKSPACE_ID`/`HOME`
  only — verify that is sufficient for `python -m honcho.mcp`).

### 2. Wire the background trigger + the opt-in UI

- Add an operator opt-in toggle that writes `commandEve.honchoMemoryOptIn` (mirror the
  `commandEve.kanbanAutoApprove` toggle in SystemModalContent).
- In the main process, AFTER app-ready, when the flag is true and the seat is not already
  fresh-ready, call `runHonchoProvisioningForSeat(...)` in the BACKGROUND (never on the
  synchronous boot path). On success the readiness file flips ready → the render layer
  (already shipped) advertises the honcho MCP server + SOUL clause on the next provisioning
  pass / seat activation. Provide `detectDeps` (which brew/psql/pgvector/venv-python/honcho-pkg,
  free disk, `os.totalmem()`), the real `defaultRunner`/`defaultDetachedSpawner`, and loopback
  `/health` + deriver probes.

### 3. Prove H-INT-12 (the one non-headless gate)

Kill the honcho server AFTER a config.yaml already advertises it and confirm the Hermes agent
DEGRADES (memory tool simply absent that turn) rather than bricking startup. If Hermes is not
fail-soft to a dead MCP server, gate the render on a live `/health` re-probe at render time.

## Safety recap

Until step 2's opt-in is set, `honchoMemoryOptIn` is absent ⇒ provisioning never runs ⇒ no
readiness file ⇒ every seat is byte-identical to pre-Honcho. Shipping the consumption wiring in
1.7.0 is therefore safe; the activation lights up only after this Mac run.

---

## Addendum (2026-07-05) — local-first toggle + shared delegate memory

Founder direction: the deriver LLM may be cloud, BUT Honcho must ALSO run fully local with a
local LLM, **toggle-switchable** — and the SAME per-seat memory must be reachable by the
Claude/Codex **delegate** workers, not just EVE. Both threads are built + verified headless
(byte-identical until Honcho is provisioned + ready). Extra Mac/wheel-verify items:

### Deriver toggle (`commandEve.honchoDeriverMode`: auto | local | cloud)

- Verify the deriver LLM env-var NAMES honcho-ai actually reads (`HONCHO_DERIVER_ENV_KEYS` in
  honchoProvisioningRun.ts — currently the OpenAI-style guess `OPENAI_BASE_URL`/`OPENAI_API_KEY`).
  The VALUES are FACT (local = `http://127.0.0.1:11434/v1` + gemma4:e4b; cloud = the loopback shim).
- Confirm WHICH process runs the deriver worker (the `honcho serve` server vs `python -m honcho.mcp`
  client) so the deriver env lands on the right process. Today it rides the serve PROCESS step.
- `local` mode is a PRIVACY-LOCK: a cold model must never fall to cloud (verify the readiness probe
  keeps it un-advertised, memory falls back to Company Brain, nothing egresses).

### Shared delegate memory (Claude via the eve-acp-launcher)

- Verify the env-var the installed `@agentclientprotocol/claude-agent-acp` adapter reads for an
  external MCP config (`CLAUDE_DELEGATE_MCP_CONFIG_ENV` in eveWorkerLauncherCore.ts — currently
  the guess `CLAUDE_MCP_CONFIG`). The launcher already exports the per-seat honcho json path there.
- Prove a live delegated Claude worker calls `honcho` and reads/writes the SAME rows EVE wrote
  (needs the provisioned honcho venv + local postgres running).
- Measure RSS of a SECOND honcho client (the delegate's) alongside EVE's on the 8GB-Air ceiling.

### Cloud-hostable memory (the "später" multi-device axis — DESIGN NOTE, not built)

The current delegate/EVE honcho MCP env uses `HONCHO_DB_URI` (direct passwordless-loopback
Postgres) — LOCAL-ONLY by design; it does NOT generalize to a cloud-hosted honcho (you never
expose Postgres to the internet). For the browser/mobile future where Honcho is hosted in EVE's
OWN cloud so the shared memory follows the user across devices/CLIs/inference, the access seam must
become the honcho **HTTP base_url** (the honcho-ai client auto-skips the api-key on loopback; a
cloud host adds a scoped key). That is an ADDITIVE axis (a `HONCHO_BASE_URL` alongside the local
dbUri path), not a rewrite — the per-seat resolution + isolation already in place carry over. Build
it when the cloud/mobile clients land, after the local path is Mac-verified.
