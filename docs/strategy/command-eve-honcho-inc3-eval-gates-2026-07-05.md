# Honcho Inc.3 — Integration Eval Gates (H-INT)

**Stand 2026-07-05.** COMPA-624 Inc.3 = wiring the already-built + already-tested pure Honcho
cores into the LIVE runtime. Inc.1 (config core) + Inc.2 (deriver-shim ingress) shipped as pure
modules with tests; the shim already carries the `honchoDeriverRoute` option + the
`handleHonchoDeriverCompletions` lane. Inc.3 is the INTEGRATION: `index.ts` (shim resolver
injection) + `runtimeBootstrapCore.ts` (config render splice · O1 bootstrap call · readiness
plumbing · SOUL clause).

**Doctrine (non-negotiable, inherited from the cores):**
- **BYTE-IDENTICAL-UNTIL-PROVISIONED.** On any seat where Honcho was never provisioned (the
  default, and every current user), the rendered `config.yaml`, the shim money surface, and the
  SOUL must be exactly what they are today. Honcho is purely additive.
- **DEFAULT-DENY / FAIL-CLOSED.** Every readiness/route/config path resolves to "not ready" on
  any missing/partial/stale/mismatched/error input. A Honcho failure NEVER blocks first value —
  fallback is Company Brain + MEMORY.md.
- **MONEY/EGRESS CONTINUITY.** The deriver lane forces the FREE 'standard' tier server-side,
  carries NO tier in the route, reads the CEVE license fresh-per-call header-only, and rides the
  loopback shim (egress boundary) — never the edge fn directly. Injecting the route must not move
  ANY money surface for an unprovisioned seat.
- **SEAT ISOLATION.** A readiness snapshot from seat B can never activate the deriver / memory
  for seat A. Per-seat honcho home, per-seat Postgres DB, per-seat workspace.

**THE SINGLE MAC RESIDUAL (out of scope for these gates):** the REAL first-start — actually
running `brew install postgresql pgvector` + `uv`/`pip install honcho-ai` + `honcho serve` +
the deriver process, and probing `/health`. That requires the founder's Mac (no honcho/postgres
in this headless env). Inc.3 builds the full inert-until-ready ORCHESTRATION with injected
runner/spawner/probes (unit-tested with fakes) and leaves exactly ONE gated trigger for the Mac.

---

## Gates

### H-INT-1 — Deriver route injected at ALL shim start sites
`index.ts` injects `buildCommandEveShimHonchoDeriverRouteResolver({...})` as `honchoDeriverRoute`
at EVERY `startCommandEveOllamaOpenAiShim` call site (the warm-boot, the cold-boot, and the
early/CLI site — all 3, same trap the kanban injection hit where the 3rd site was missed).
*Test:* grep-gate asserting `honchoDeriverRoute:` appears at each of the 3 sites (or a shared
builder used at all 3). tsc 0.

### H-INT-2 — Reader/writer honcho-home path IDENTITY
The shim resolver's `readHonchoSeatReady(seatId)` reads readiness from the EXACT same
`<hermesHome>/honcho/honcho-readiness.json` that `runHonchoBootstrap`/`writeHonchoReadyState`
writes. A path divergence = a permanently-inert deriver lane (silent dead feature).
*Test:* a unit test that writes readiness via the writer's path derivation for a seat, then reads
it via the shim reader's derivation for the SAME seat id, and asserts byte-equality of the object.

### H-INT-3 — Unprovisioned seat is byte-identical
With NO readiness file present, the injected resolver returns `{ active: false }` and the shim's
`/honcho/deriver` lane stays 503 — the chat/money path is unchanged.
*Test:* resolver returns `{active:false}` when `readHonchoSeatReady` yields undefined; existing
deriver-lane test proves 503 when inactive.

### H-INT-4 — memory.provider render is readiness-gated
`config.yaml` emits `memory.provider: honcho` (+ the honcho.json pointer) ONLY when that seat's
readiness snapshot is `ready`. Not-ready / absent ⇒ the memory block is omitted and the file is
byte-identical to today.
*Test:* render the seat config with readiness=ready → contains the honcho memory block; with
readiness undefined/off → byte-identical to the pre-Honcho render (golden compare).

### H-INT-5 — honcho.json is per-seat + loopback + no secret
The written `$HERMES_HOME/honcho.json` carries baseUrl = the loopback shim/local base (so the
honcho client auto-skips the API key), workspace = `ws_<seatId>` (opaque, never the human label),
and contains NO license/secret literal. Mode 0600.
*Test:* render honcho.json for a real seat → assert workspace id shape, loopback baseUrl, absence
of any secret, and that two different seat ids produce different workspace ids.

### H-INT-6 — O1 bootstrap spliced with real runner/spawner, never throws into boot
`runHonchoBootstrap` is called from the per-seat bootstrap entry with the in-scope
`defaultRunner`/`defaultDetachedSpawner` + real probes, and its result NEVER flips the
runtime-bootstrap receipt off 'ready' / blocks first value (every Honcho miss = 'skip').
*Test:* drive the splice with a plan disabled / a throwing runner / a dead probe → the outer
bootstrap still returns ready; Honcho stages are all skip; readiness file is written not-ready.

### H-INT-7 — Consent gate blocks provisioning
Provisioning does not start unless the operator consent state is granted (buildHonchoProvisionPlan
mode/consent). Absent/declined consent ⇒ plan disabled ⇒ one skip stage ⇒ off/declined readiness.
*Test:* plan with consent declined → `honchoEnabled:false`, readiness declined, no command run.

### H-INT-8 — Disk/RAM floor honored
On < HONCHO_MIN_FREE_DISK_GB free or < HONCHO_MIN_UNIFIED_MEMORY_GB unified memory, the plan is
BLOCKED (never attempts brew/pg) with the honest reason code.
*Test:* provision plan inputs below each floor → blocked reason `HONCHO_BLOCKED_DISK` /
`HONCHO_BLOCKED_RAM`; no steps enabled.

### H-INT-9 — SOUL clause is readiness-gated + honest
The SOUL/directive gains a Honcho "you have durable per-seat memory — recall/remember across
sessions" clause ONLY when readiness=ready. Not-ready ⇒ SOUL byte-identical to today (EVE never
claims a memory it doesn't have).
*Test:* directive builder with ready → contains the memory clause; not-ready ⇒ '' (byte-identical).

### H-INT-10 — readiness file is the single source, always written
Every bootstrap outcome (off / declined / blocked / provisioning-failed / ready) WRITES a readiness
snapshot carrying seat + branch; 'ready' only when BOTH probes pass. No path leaves a stale prior
snapshot.
*Test:* covered by honchoBootstrapCore's own suite; add one splice-level test that the file exists
post-splice for the disabled path.

### H-INT-11 — Full suite green + tsc 0 + Codex-clean
Whole command-eve suite green (no regression from the wiring), tsc 0, and a final Codex xhigh
adversarial audit of the Inc.3 wiring returns SOUND (money continuity + fail-closed + path identity
+ no brick path).

---

## Mac residual (explicit, gated)
After Inc.3 lands green + Codex-clean, the ONLY remaining step is on the founder's Mac:
trigger the real provisioning once (consent → brew/pg/pgvector/uv/honcho-ai → `honcho serve` →
`/health` + deriver probe → readiness flips to ready). At that point H-INT-4/5/9 flip live and the
deriver lane (H-INT-3) activates — all already unit-proven with fakes. No code change needed for
the Mac step; it is a runtime action behind the consent gate.
