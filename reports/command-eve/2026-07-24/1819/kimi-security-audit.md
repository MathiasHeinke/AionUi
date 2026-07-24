# Kimi K3 security audit — Command EVE 1.819 security release gates

Runtime proof: Kimi Code CLI `0.28.1`, model alias `kimi-code/k3`, authenticated
CLI lane. Auth canary `KIMI_1819_SECURITY_CANARY_7F3A29C4` returned exactly;
the audit report below begins with canary `KIMI_1819_SECURITY_AUDIT_CANARY_9D2E41B7`.
Review mode was read-only; the reviewer changed no repository, Git, Plane, or
release state. Kimi session `session_ae6ff5cc-4573-4eae-9763-e126940a2f13`.

Audited candidate: `3e23246cf929a47a760be4ac0c0e61e6bf702f91`
(`codex/command-eve-1819-security`, "feat(command-eve): close 1.819 security
release gates"). Tier-1 scope: committed delta `35c9e37f..3e23246c` (37 files,
+3408/-242). Tier-2 scope: uncommitted working-tree delta (85 files, +3310/-753)
reviewed at scan level only, non-blocking. Audit contract and raw stream:
`/tmp/kimi-1819-audit-9BwAuR/` (`audit-prompt.md`, `committed.patch`,
`worktree.patch`, `kimi-raw-output.txt`).

---

KIMI_1819_SECURITY_AUDIT_CANARY_9D2E41B7

## Verdict

PASS-WITH-CONDITIONS (Tier 1 only — committed delta `35c9e37f..3e23246c`)

## Findings

| ID   | Severity | file:line                                                                                          | Title                                                                                         | Evidence                                                           |
| ---- | -------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| F-01 | P1       | .github/workflows/pr-checks.yml:17-21                                                              | Exception ledger changes never trigger the audit gate                                         | FACT(.github/workflows/pr-checks.yml)                              |
| F-02 | P2       | packages/desktop/src/common/config/commandEveShell.ts:34-42                                        | Founder-only boundary is a runtime env var in shipped builds                                  | FACT(packages/desktop/src/common/config/commandEveShell.ts)        |
| F-03 | P2       | packages/desktop/src/common/adapter/main.ts:46-54                                                  | Adapter trust check asserts window identity, not origin URL                                   | FACT(packages/desktop/src/common/adapter/main.ts)                  |
| F-04 | P2       | packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts:1848                                   | `ollamaBaseUrl` option not confined to loopback                                               | FACT(packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts)  |
| F-05 | P2       | packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts:935,1247,1504                          | All upstream fetches follow redirects cross-origin                                            | FACT(packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts)  |
| F-06 | P2       | scripts/afterPack.js:94; scripts/afterAllArtifactBuild.js:610                                      | Private-key/public-key guards run on macOS lane only                                          | FACT(scripts/afterPack.js)                                         |
| F-07 | P2       | scripts/release/verify-command-eve-first-run-bundle.mjs (whole file)                               | C9 first-run bundle gate is not wired into any pipeline                                       | FACT(scripts/release/verify-command-eve-first-run-bundle.mjs)      |
| F-08 | P2       | scripts/security/production-audit-gate.mjs:46                                                      | `bun audit --production` is a no-op flag; documented ledger scope is false                    | FACT(scripts/security/production-audit-gate.mjs)                   |
| F-09 | P2       | scripts/security/production-audit-gate.mjs:78-89                                                   | `requiredAbsentRuntimeImports` is a substring scan; node_modules excluded                     | FACT(scripts/security/production-audit-gate.mjs)                   |
| F-10 | P2       | scripts/release/verify-no-private-keys.mjs:29,63                                                   | Private-key content scan restricted to key-file extensions                                    | FACT(scripts/release/verify-no-private-keys.mjs)                   |
| F-11 | P3       | packages/desktop/src/index.ts:1256-1261; packages/desktop/src/sentry.ts:184-190                    | Opt-out does not close Sentry client; queued/session envelopes can still flush                | FACT(packages/desktop/src/sentry.ts)                               |
| F-12 | P3       | packages/desktop/src/sentry.ts:117-124; packages/desktop/src/renderer/main.tsx:12-33               | Stack-frame paths outside redactor; renderer Sentry init unconditional                        | FACT(packages/desktop/src/sentry.ts)                               |
| F-13 | P3       | packages/desktop/src/common/adapter/security/bridgePolicy.ts:118-135                               | Exact payload schemas for only 5 of ~150 providers                                            | FACT(packages/desktop/src/common/adapter/security/bridgePolicy.ts) |
| F-14 | P3       | packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts:1948,1649-1655                         | Router 500 echoes raw error.message; receipts record `completed` on non-OK upstream           | FACT(packages/desktop/src/process/commandEve/ollamaOpenAiShim.ts)  |
| F-15 | P3       | scripts/security/production-audit-gate.mjs:21-23; scripts/release/verify-no-private-keys.mjs:33-36 | Gate test-hook flags (`--now`/`--audit-json`/`--ledger`); key scanner swallows readdir errors | FACT(scripts/security/production-audit-gate.mjs)                   |
| F-16 | P3       | .github/workflows/pr-checks.yml:79-80                                                              | UNVERIFIED: whether the `Code Quality` check is required in branch protection                 | FACT(.github/workflows/pr-checks.yml)                              |

**F-01 (P1)** — The exception ledger lives at `docs/security/production-advisory-exceptions.json`, and `paths-ignore` excludes all of `docs/**`. A PR touching only the ledger (extending `expiresAt`, weakening a rationale, adding an exception) never runs the gate, so the single most security-sensitive file in this release gets zero automated validation at merge time. Enforcement recovers on the next code-touching PR, so it is a delayed rather than permanent bypass. Remediation: remove `docs/security/**` from `paths-ignore`, or add a dedicated workflow triggered on the ledger path that runs `bun run security:audit:production`.

**F-02 (P2)** — The founder-only provider set (team-manage apply/reject, kanban mutations, report-export, CDP config, DevTools) is gated by `COMMAND_EVE_FOUNDER_BUILD=1|true` read from mutable process env, honored identically in packaged builds. Any local user launching the app with the env var unlocks the founder surface; it is not remotely triggerable and the main process enforces it consistently, but an entitlement-grade role is keyed on the weakest possible signal. Remediation: in packaged builds require a signed entitlement/license marker or a compile-time flag in addition to (or instead of) the env var.

**F-03 (P2)** — `isTrustedAdapterIpcSender` proves the sender is the registered main window's main frame but never checks what URL that frame is showing; origin soundness rests entirely on the `will-navigate` guard in `index.ts` (outside this delta). If that guard regresses, remote content inherits the full 150-provider bridge surface. Remediation: also assert `sender.getURL()` against `isTrustedMainRendererUrl` inside the IPC handler for defense in depth.

**F-04 (P2)** — The shim's `ollamaBaseUrl` option is accepted verbatim and POSTed to without the loopback validation applied to the managed-route base URL. I verified all three production call sites never pass it and no env var feeds it, so it is not reachable in 1.819 — but any future caller plumbing config into it silently creates off-host egress. Remediation: run the loopback validator on the resolved `ollamaBaseUrl` in `startCommandEveOllamaOpenAiShimOnce` and fail closed.

**F-05 (P2)** — All three upstream lanes (ollama, EVE cloud, managed local) call `fetch` without a `redirect` option, so a 30x from a compromised upstream re-POSTs the body cross-origin. The bearer is stripped by undici on cross-origin redirects and bodies are redacted per egress policy, hence P2. Remediation: set `redirect: 'error'` on all three calls; no lane has a legitimate redirect.

**F-06 (P2)** — `afterPack` runs the packaged-resources verifier only for `darwin`, and `afterAllArtifactBuild.js` returns early on non-darwin before its private-key guard; the Windows verifier contains no key checks, yet Windows targets ship the same `public/` content. A private license-signing key dropped into `public/` would sail into the NSIS installer — the exact catastrophic scenario the scanner's own comments describe. Remediation: run `verify-no-private-keys.mjs` as an explicit step in Windows CI and extend the packaged-resources check to the Windows layout.

**F-07 (P2)** — The C9 first-run bundle gate (fresh-run receipt ↔ version binding, identity chain, onboarding skill byte-identity) is referenced only by itself and its test: not in the release-gate aggregator, not in any workflow. Its mechanics are sound (every failure mode maps to a distinct non-zero `BLOCKED_*` exit, fail-closed catch-all), but it enforces nothing unless a human remembers to run it. Remediation: wire it into the release aggregator or a checklist-enforced runbook step.

**F-08 (P2)** — `bun audit` has no `--production` flag and silently ignores unknown flags (empirically confirmed), so the gate audits the full lockfile including devDependencies while the ledger declares `"scope": "bun audit --production --json"`. Failure direction is safe (stricter), but the documented scope is false and every dev-only advisory will demand an exception, creating rubber-stamp pressure. Remediation: drop the no-op flag and correct the ledger scope string.

**F-09 (P2)** — The forbidden-import tripwire is `String.includes` over `packages/**` source: trivially evaded by `import('@hono/' + 'node-server')` and blind to the real reachability surface (`node_modules`, `resources/` shipped code are excluded). It is a first-party tripwire, not the reachability proof the ledger claims; currently zero hits. Remediation: document it as a tripwire; consider a real module-graph check against production entry points.

**F-10 (P2)** — The private-key scanner content-scans only `.key/.pem/.p8/.pk8/.der/.asc` and extensionless files; a PEM saved as `license.txt` or `keys.dat` in a shippable path evades it. Deliberate tradeoff against npm-doc false positives. Remediation: additionally content-scan small text-extension files in the hand-picked shippable roots (`public/`, `resources/`).

**F-11 (P3)** — The consent-set bridge provider only writes the consent file; `Sentry.close()` is never called, so envelopes that passed `beforeSend` while consent was on (offline buffer, retry backoff) and anonymous session envelopes can still transmit after opt-out — while the new UI copy promises "stops immediately." Requires prior opt-in; small window. Remediation: call `Sentry.close(0)` on `setConsent(false)`.

**F-12 (P3)** — The redactor scrubs message/exception/contexts/extra/breadcrumbs/request but not stack-frame `filename`/`abs_path` (OS-username leak via `/Users/<name>/…`), and the renderer Sentry init runs unconditionally with no redaction of its own — safe today only because it has no DSN and egress routes through the consent-gated main process. Remediation: extend redaction to frame paths; add an explicit consent check or assert-no-DSN guard at the renderer init.

**F-13 (P3)** — Only 5 providers get exact-key payload validation; the other ~145 accept arbitrary JSON up to 50 MB, so the policy guarantees envelope shape, not per-provider input safety. Handlers must self-validate. Remediation: extend the exact-schema table to mutation providers over time; consider lowering the payload cap for this channel.

**F-14 (P3)** — The shim's top-level 500 handler echoes raw `error.message`, bypassing the deliberate never-echo discipline inside handlers (no current throw source embeds credentials; latent channel only). Separately, non-OK upstream statuses record `outcome: 'completed'` in the audit receipt, weakening it as watchdog evidence. Remediation: generic 500 message server-side logging; call `markUpstreamError()` on non-OK status.

**F-15 (P3)** — The gate accepts `--now` (clock rollback), `--audit-json` (audit substitution), `--ledger` unconditionally; CI passes none, so this equals the trust level of editing the gate itself. The key scanner also silently skips unreadable directories (fail-open on I/O). Remediation: mark flags test-only or gate behind an env var; record a finding on unreadable dirs.

**F-16 (P3, UNVERIFIED)** — The CI step itself is correctly blocking (no `continue-on-error`, right script, right job), but whether the `Code Quality` check is required in GitHub branch protection cannot be verified from the repository. If it is not required, the entire gate is advisory.

**Secrets scan (focus 10): clean.** The only pattern matches in the committed delta are test canaries (`sk-reasoningcanary…`, `sk-abcdefghijklmnopqrstuvwxyz123456`, `fixture-token`, a synthetic `-----BEGIN PRIVATE KEY-----\nforbidden` fixture), a test-only Sentry DSN on `example.invalid`, and the `command-eve.auth-password-login` channel name. Sentry DSN comes from `process.env.SENTRY_DSN` only; the two shipped license PEMs are public keys by design. No real secrets, keys, or tokens were added.

## Conditions before release claim

1. Fix F-01: scope `docs/security/**` out of `paths-ignore` (or add a ledger-triggered workflow) so the exception ledger cannot change without the gate running.
2. Resolve F-16: confirm in repo settings that the `Code Quality` check (or whichever job runs `security:audit:production`) is a required status check on the release branch.
3. Resolve F-07: wire the C9 first-run bundle gate into the release process — aggregator entry or a checklist-enforced manual runbook step — since the commit claims to "close 1.819 security release gates."
4. Fix F-06: run the private-key scan (and ideally the public-key byte-identity check) on the Windows release lane before shipping Windows artifacts.
5. Fix F-08: remove the phantom `--production` flag and correct the ledger's declared audit scope so the "security release" documentation matches what the gate actually does.

## Tier-2 WIP observations

Non-blocking; none of this changes the Tier-1 verdict. Reviewed at scan level only, not audited in depth.

- **Boundary widening in progress (highest significance):** the uncommitted delta moves four `kanban-marketing-*` providers and `command-eve.report-export` out of `FOUNDER_ONLY_PROVIDER_KEYS` into a new `customer-default-kanban` authorization tier, and adds new customer-callable providers (`managed-visual-turn-authorize`, `image-prepare`, `presentation-prepare`). The conditional validation in the worktree hunks looks fail-closed (customers restricted to `boardSlug === 'default'`, exact-key schemas, founder-only fields like `eventLedgerPath` stripped for customers), but this is new customer-reachable attack surface that deliberately reshapes what Tier 1 reviewed — it needs its own security review before it ships in any release.
- `imageGenServer.ts` WIP introduces `readManagedLoopbackApiKey`, moving the image-gen key from an env var into the `shim-auth-token` file (absolute-path + basename + `lstat` checks present — good direction), but the token file's permission bits and the full call chain are unreviewed.
- A bundled binary changed: `resources/bundled-hermes/hermes_agent-0.17.0-py3-none-any.whl` (binary diff). Provenance/hash verification of this wheel is unverified.
- `resources/bundled-skills/ai-coding-delegation/SKILL.md` WIP adds an "autonomous (operator opt-in)" skip-permissions mode for delegated coding workers — a prompt-governance change with real security implications; wording keeps hard floors (no secrets exfiltration, no production deploys) but this is unreviewed policy surface.
- `public/command-eve-capabilities.json` grew by ~238 lines (capability manifest expansion) — unreviewed.
- Large renderer WIP (AcpSendBox +158, pending-confirmations recovery, local runtime page rewrite, `index.ts`/`commandEveBridge.ts`/`runBackendMigrations.ts` changes) — not reviewed for this audit.
- Secrets scan of the worktree delta: clean — matches are env-var names (`AIONUI_IMG_API_KEY_FILE`), skill-doc guidance about `ANTHROPIC_API_KEY` hygiene, and test fixtures (`process-local-nonce`, `remote-secret`).

## Overall assessment

The committed 1.819 delta is a genuine hardening release: the new bridge policy implements real default-deny (exact-key registry, fail-closed parse, tightened sender-frame check, founder-only enforcement in the main process), the egress shim confines traffic to loopback or the https edge with no credential forwarding and sound URL validation, telemetry consent is opt-in and synchronously enforced before any Sentry call with scrubbing strengthened rather than weakened, the packaging verifiers fail the build on any violation, and the production audit gate fails closed with strong ledger integrity rules — and no secrets were added. The one P1 is procedural rather than code-level: the security exception ledger sits under CI `paths-ignore`, so the most sensitive file can change without the gate firing, which must be fixed before the "security release" claim is made. The P2 cluster is dominated by coverage gaps (mac-only key guards, an unwired C9 gate, a no-op `--production` flag, an env-var-only founder boundary) — none exploitable as shipped, all worth closing before the next release. Provided the five conditions above are met, Tier 1 supports shipping 1.819.
