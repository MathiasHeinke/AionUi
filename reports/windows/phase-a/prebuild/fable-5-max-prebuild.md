# FABLE 5 MAX — Command EVE Windows x64 Phase A Pre-Build Review (Independent, Read-Only)

Status: COMPLETE
Worktree audited: /Users/mathiasheinke/Developer/.agent-sandboxes/aionui/eve-windows-x64-integration @ 5af678cc (clean, branch codex/command-eve-windows-x64-integration; verified via git log/status)
Canonical plan: Company.OS docs/strategy/command-eve-windows-x64-productization-program-2026-07-14.md (read in full, 1705 lines)
Phase-A contracts: supergoals-2026-07-14/ README + parent + WIN-000..WIN-070 (read in full)
Method: principal read of plan+contracts; three bounded read-only specialists (CI/packaging+E2E, platform/bootstrap, entitlement/cloud-chat); principal first-hand verification of remotes/CI history, AionCore release asset bytes, managed CDN manifests, better-sqlite3 prebuilds, 7zip-bin patch, package.json pins. No file edits outside this plan file, no Plane/Linear writes, no secrets read or reproduced, no production/release actions. No Hermes-free direct-provider lane is proposed anywhere in this review (constraint honored; code audit confirms no such lane exists to revive: zero provider chat hostnames in the main process; BYOK is a separate gated feature).

## 1. Executive verdict

Phase A is buildable on this codebase and the canonical plan's architecture decisions survive independent audit. Every plan FACT that specialists checked (26 of 26) was CONFIRMED at current line anchors, with three refinements and one refutation of detail (none overturning a decision). The audit adds one genuinely new P0-class gap the plan missed (the bundled-Python **runtime resolver** is POSIX-hardcoded — fixing only the fetch/staging side would still yield PYTHON_MISSING), one new hard prerequisite (Command EVE code has **zero CI history anywhere**; the fork's Actions have never run), and it resolves the plan's biggest packaging unknown in Phase A's favor (the AionCore win32-x64 assembly chain is a build-time self-assembly with all CDN inputs published and SHA-pinned; verified live today). The committed 5-8 focused-day estimate for Phase A remains credible at medium confidence with two lanes; the 4-day stretch is not credible.

## 2. Findings

Legend: FACT(file:line) = directly observed in code/bytes/live endpoints; INFERENCE = supported conclusion not yet executed on Windows; HYPOTHESIS = must be tested.

### P0 — Phase A cannot exit without these

**P0-1. Windows release build lane is fail-open.**
FACT(.github/workflows/_build-reusable.yml:317-340): the Windows electron-builder step try/catches, prints "build failed but will not block the workflow", writes `result=failure` to outputs, never exits non-zero; artifact upload (584-600) and asar check (544-547) silently skip; FACT(.github/workflows/build-and-release.yml:254-262) then releases on green. A release can exist with no Windows artifact. Fix in WIN-020 (already scoped). Test: deliberate failing Windows command must turn the workflow red (WIN-G03).

**P0-2. Bundled-Python is broken on Windows on BOTH sides — build-time staging AND runtime resolution. The runtime half is NEW vs the plan.**
- Build: FACT(scripts/fetch-bundled-python.mjs:54-59,60-70): triples map only to *-apple-darwin, SHA table arm64-only (x86_64 slot is Intel macOS with null sha); FACT(scripts/build-with-builder.js:659-661): fetch invoked only for --mac/--all; FACT(packages/desktop/electron-builder.yml:175): `from: build/bundled-python/python` mapped unconditionally → first Windows builder run either ENOENT-fails or ships a python-less app while the Hermes wheel still ships (145-149). HYPOTHESIS(which of the two): resolve on first runner build. FACT(upstream v2.1.35 electron-builder.yml via gh api): upstream has NO bundled-python/bundled-hermes mapping — this surface is fork-specific; upstream's green Windows releases prove nothing here.
- Runtime (NEW): FACT(runtimeBootstrapCore.ts:197): `BUNDLED_PYTHON_REL_SEGMENTS = ['python','bin','python3.12']` joined unconditionally (244-248); FACT(:205): win32 absolute-candidate list is `[]`. A correctly staged Windows CPython (`python/python.exe` — the PBS Windows install_only layout has no `bin/`) will NOT resolve; bootstrap lands on PYTHON_MISSING and FACT(:4458-4466) returns before Hermes → no cloud chat.
- Refinement (refutes a plan detail): python-build-standalone Windows install_only is also `.tar.gz`, and `tar -xzf` works on Windows 10 1803+ (bsdtar) — extraction format is NOT the problem; the deltas are triple map, SHA pin, and interpreter layout. FACT(fetch-bundled-python.mjs:49-51,70-78,135-152): pin+fail-closed SHA skeleton already exists — extend, don't rewrite.

**P0-3. The Hermes turn-holder launch chain hands Windows a bash script — in three places, one of which the plan missed.**
FACT(runtimeBootstrapCore.ts:2576-2594): `writeHermesCliShim` writes a `#!/usr/bin/env bash` shim; FACT(packages/desktop/src/index.ts:1785,1859): startup passes `paths.hermesShim` as `hermesCommandPath`; NEW SURFACE FACT(assistantStorageRepair.ts:190-214,238-245): that shim path is pinned into the Hermes agent **registry row that aioncore execs** — the fix must update the row repair too, not just index.ts. FACT(runtimeBootstrapCore.ts:2467-2471): `hermesConsoleBinary` already resolves `Scripts\hermes.exe` — the Windows launch target exists. FACT(:2333-2341): `commandExists` shells `bash -lc 'command -v'` — dead on a fresh Windows box; use `where` on win32. Also FACT(:3834-3845): a second bash artifact (`hermes-command-eve` wrapper) is written and PATH-prepended — Phase-B surface for Hermes-internal spawns, flag but don't block Phase A.

**P0-4. Hermes install has no offline dependency closure — first boot hard-requires PyPI. Make this an explicit product decision, not an accident.**
FACT(resources/bundled-hermes/): exactly one file, hermes_agent-0.17.0-py3-none-any.whl (pure py3-none-any). FACT(runtimeBootstrapCore.ts:4518,4522-4534): `pip install --upgrade pip` then `pip install <wheel>[acp]`, no `--no-index`/`--find-links`; wheel METADATA declares ~28 runtime deps (openai, pydantic, Pillow, fastapi, uvicorn, httpx…) plus win32-conditional tzdata, **pywinpty (native)**, concurrent-log-handler, and agent-client-protocol==0.9.0 — none bundled. Clean-VM-with-network passes; PyPI-blocked network fails the hermes stage (classified at :4538-4539, no crash). Decision D1 for WIN-040: bundle a pinned win32 `--find-links` wheel closure (installer grows; supply-chain pinning improves) vs. document PyPI as a Phase-A network prerequisite and gate it in the bootstrap receipt. WIN-040's acceptance line "bootstraps without system Python or Git assumptions" must state the network assumption explicitly either way.

### P1 — must be scheduled inside Phase A, will bite otherwise

**P1-1. Command EVE has zero CI history anywhere; the CI execution substrate itself is unproven. (NEW — not in the plan.)**
FACT(git remote -v): origin = iOfficeAI/AionUi (upstream); Command EVE branches live on remote `mathias` = MathiasHeinke/AionUi. FACT(gh api): that fork is PUBLIC, Actions enabled, **total workflow run count = 0**; FACT(git): the integration branch has no upstream — local-only. All green-Windows-CI evidence cited in the plan (run 29323639527) is upstream code on the upstream repo. Consequences: (a) Phase 0/A needs an explicit "CI bring-up + baseline red run" step — first runs will surface non-Windows breakage too; (b) public-fork governance: evidence bundles under reports/windows/ and any CI secrets on a public repo need a WIN-000/WIN-010 decision (fork-PR secret rules, 4-vCPU public runners vs 2-vCPU private); (c) FACT(.github/workflows/release-distribute.yml:108-135): hard-requires latest.yml AND latest-win-arm64.yml (+mac/linux) — an "x64-only initial matrix" (WIN-020 scope) breaks this workflow unless adjusted in the same wave; (d) FACT(_build-reusable.yml:596-597): ZIP upload globs are stale AionUi names — the win ZIP (a Phase-A contract artifact) is silently dropped from CI artifacts.

**P1-2. Stale AionUi naming: the only Windows install smoke false-FAILS on a correct build (refinement: false-fail, not false-pass).**
FACT(pr-checks.yml:490,499-501,520-527): blocking smoke globs `AionUi-*-win-*.exe` and probes `Programs\AionUi`; electron-builder emits `Command EVE-<ver>-win-x64.exe` (electron-builder.yml:185) → glob finds nothing → throw → the blocking windows job goes red on a CORRECT build the moment fork CI turns on. FACT(scripts/packaged-launch.mjs:31-35): AionUi-only, no Command EVE fallback — cannot launch a Command EVE build at all. FACT(scripts/build-with-builder.js:733-777): AionUi.exe hardcodes are dev-only (CI-gated at :758). FACT(scripts/create-mock-release-artifacts.sh:16-39 + scripts/verify-release-assets.sh:68): release-script-test validates stale AionUi-1.0.0 mock names — green while proving nothing. FACT(resources/windows-installer-x64.nsh:14-26): stale AionUi branding + iOfficeAI URL in the arch-mismatch dialog. Fix: WIN-020's single product-name resolver + a grep-gate test that fails on any residual `AionUi` in workflows/scripts/nsh smoke paths. Reuse pattern: tests/e2e/fixtures.ts:108-113 dual-name probe.

**P1-3. AionCore win32-x64 packaged-bundle assembly: mechanism verified feasible, fork pins unexercised. (Plan's biggest unknown — now mostly resolved in Phase A's favor.)**
FACT(prepare-aioncore.js:157-177): managed-resources are self-assembled at build time by exec'ing the TARGET-platform aioncore binary (`aioncore.exe prepare-managed-resources`) — therefore Windows packaging MUST run on a Windows runner (hard technical constraint, matches invariant 2, kills any cross-build shortcut). FACT(downloaded today, unzip -l): aioncore-v0.1.37-x86_64-pc-windows-msvc.zip contains exactly ONE file, aioncore.exe (75.2 MB) — no manifest, no node, no ACP. FACT(live CDN, curl today): static.aionui.com publishes SHA-pinned win inputs: managed/node v24.11.0 win-x64 zip; codex-acp 0.14.0 win32-x64 zip (119.6 MB); claude-agent-acp 0.39.0 win32-x64 zip (82.5 MB). FACT(afterPack.js:76 → verify-bundled-aioncore-resources.js:47-145): fail-closed gate requires aioncore.exe + manifest + managed node.exe + BOTH ACP tool trees for win32-x64. INFERENCE: upstream shipped green Windows releases today via the same self-assembly mechanism (aioncore v0.1.47, Electron 37) — mechanism proven; the fork's exact pair (v0.1.37 + Electron 42.6.1) needs one verification run. Notes: build-time network to static.aionui.com is now a declared CI dependency (~230 MB per cold build; provenance receipt for these downloads belongs in Phase C WIN-130).

**P1-4. Production fuses make the Playwright packaged harness undrivable; Phase A smoke must be spawn-based. (NEW for Phase A execution truth.)**
FACT(scripts/electronFusePolicy.js:8-11 + afterPack.js:84): RunAsNode/EnableNodeCliInspectArguments hard-off on all platforms, strictlyRequireAllFuses, no instrumented profile exists; FACT(tests/e2e/fixtures.ts:7-11): packaged Playwright mode needs the inspect fuse. Phase-A packaged lifecycle proof should use the existing spawn-based launchers — FACT: scripts/benchmark-startup.ts:294-348 and tests/e2e/specs/command-eve-auto-update.e2e.ts:229-262 both resolve `Command EVE.exe` on win32 and drive via spawn — or pull ADR-WIN-009's instrumented artifact forward (decision D3; spawn-based is the smaller Phase-A path and matches "packaged app, not dev server" in WIN-070).

**P1-5. Process supervision: the Phase-A pair is already Windows-ready; only the transient bootstrap runner is not. (Softens plan risk R5 for Phase A.)**
FACT(packages/web-host/src/backend-launcher.ts:395-423,664-668,868-895): aioncore spawn + `taskkill /PID /T [/F]` tree kill + exit safety net; FACT(agent-process-registry.ts:82-85,141-157): Hermes ACP children tree-killed on win32; FACT(index.ts:2246-2281): before-quit cleanup runs the same path under a 10s master timeout — Hermes/aioncore do not survive app exit on Windows. Remaining gap FACT(runtimeBootstrapCore.ts:1449-1451): the bootstrap install runner (venv/pip probes) sends a single SIGTERM to the direct child only — a cancelled mid-bootstrap can orphan python/pip. Fix in WIN-030 (taskkill /T on win32). Plan ADR-WIN-005 stands for Phase B/C hardening.

**P1-6. Entitlement/credits: the purchased-credit invariant is structurally defended in code; three specific silent-degradation branches are the real Windows test targets. (NEW test rows vs the plan's matrix.)**
Defenses confirmed: FACT(entitlementCore.ts:1137-1258): Ed25519 signed-wire re-verified on every read, server-authoritative, offline-robust; FACT(entitlementOnlineCheckCore.ts:19-45,268-331): online revoke check default-inert on every transient path; FACT(creditsCore.ts:240-242): free+credit-tank reclassified 'starter', isFree=false; FACT(eveInferenceCore.ts:110-113): client sends tier:'standard' and the SERVER decides free-cap vs credit-meter; FACT(accountSessionAtRest.ts:104-126 + keychain.ts:65-116): session/wire at rest only ever `keychain:v1:` ciphertext via safeStorage (DPAPI on Windows), fail-closed drop if unavailable; FACT(ollamaOpenAiShim.ts:833,1061 + runtimeBootstrapCore.ts:1611-1613): Hermes never receives the account bearer — only a loopback per-boot nonce file path; the CEVE wire is user-scoped and expiring, satisfying "no reusable service credential in client-readable config". Negative-test rows that MUST be in WIN-060: (a) FACT(commandEveBridge.ts:163-180 + eveInferenceCore.ts:564-567): credits-status failure returns tier:'free', has_active_topup:false → transient BYOK/Pro re-lock for topup-only users; (b) FACT(inferenceSelectionBackendRead.ts:87-90): selection read fail-soft → paid EVE-Max user silently served free Standard/Flash; (c) FACT(index.ts:522-524 + ollamaOpenAiShim.ts:869-873): resolver/keychain error → shim stays LOCAL or 401 (degradation, not free-billing — still a matrix cell); (d) FACT(eveInferenceCore.ts:611 + useEveInferenceSelection.ts:149-156): trialing-only greying + auto-reset to Standard — verify paid non-trial never classified trialing.

### P2 — schedule-neutral, fix opportunistically or accept with receipt

- FACT(ollamaOpenAiShim.ts:53-72 et al.): 0o600/0o700 are no-ops on NTFS; DPAPI covers the true secrets, but the shim-auth nonce file is same-user-readable → tighten ACL or accept with documented reasoning (WIN-010 contract note).
- FACT(ollamaOpenAiShim.ts:31,1586): fixed loopback port 25811 — port-conflict/firewall-prompt watch item for the clean-VM run (E2E uses ephemeral via AIONUI_E2E_TEST=1).
- FACT(_build-reusable.yml:357-376 + build-and-release.yml:73): `secrets: inherit` exposes Apple/Sentry/GH secrets to Windows jobs that can't use them — tighten in WIN-020/WIN-120 wave.
- FACT(electron-builder.yml:45-46,109-110,266-267): dead bcrypt/node-pty globs (not deps; bun.lock confirms) — remove or justify per plan; FACT(package.json:163 + electron-builder.yml:98): sharp is a root dep but excluded from the bundle and unimported in packages/scripts — plan's "better-sqlite3 only native runtime dep" holds; consider dependency hygiene later.
- INFERENCE(gh api WiseLibs/better-sqlite3 v12.11.1 assets): win32-x64 Electron prebuilds published through ABI v146 — Electron 42.6.1 is inside the covered range; plan HYPOTHESIS downgraded to low risk; still assert prebuild-resolution (not silent MSVC compile) in WIN-020's module-load test. MSVC fallback exists (rebuildNativeModules.js:235-325).
- FACT(accountSessionAtRest.ts:61, licenseWireAtRest.ts:49, entitlementOnlineCheckCore.ts:163): os.homedir() fallback dirs — assert real userData path is always passed on Windows (%APPDATA%).
- FACT(utils.ts:99-102): ~/.command-eve symlink is try/caught — not a blocker without Developer Mode. FACT(patches/7zip-bin@5.2.0.patch): darwin-only effect; win32 path untouched.
- Public-repo governance (see P1-1c) and DPAPI-in-CI note (safeStorage in non-interactive runner contexts may fail-closed-drop → re-login loops in packaged CI tests; plan the test account flow accordingly).
- Phase-B deferrals confirmed correct (no Phase-A action): /bin/sh delegate launcher (eveWorkerLauncherCore.ts:150,185 + eve-acp-launcher.sh), localSttCore PATH/HOME issues (:133-168,46), ollama/model stages (RBC:287,4730-4913), crm/kanban/connector spawnSync overlays, hermes bash wrapper (RBC:3834-3845).

## 3. Plan-claim verification summary

26/26 checked plan FACTs CONFIRMED at current anchors. Refinements: (1) PR Windows smoke false-FAILS rather than false-passes (the deceptive-green is only in the release lane); (2) build-with-builder AionUi hardcodes are dev-only (CI-gated); (3) entitlement renderer hooks are read-only mirrors — enforcement lives in main/shim/server (plan conclusion unchanged); (4) REFUTED detail: Windows CPython staging does not need zip handling — PBS ships .tar.gz for Windows and tar.exe exists on Win10 1803+; the real deltas are triples/SHA/layout. The plan's Fable-review-record corrections (R2 proxy exists, no Hermes-free lane, upstream evidence ≠ product proof) all re-verified sound.

## 4. What Phase A can reuse (verified, with anchors)

1. afterPack integrity backbone: scripts/afterPack.js:41-232 (native rebuild + fuse policy + aioncore verify) — already fail-closed on Windows.
2. AionCore Windows prep end-to-end: prepare-aioncore.js (aioncore.exe, pc-windows-msvc.zip, PowerShell download/extract, SHA pin package.json:316-318) + binaryResolver.ts (win32-ready aioncore.exe resolution).
3. Win-ready process supervision: backend-launcher.ts taskkill-tree + agent-process-registry.ts + index.ts before-quit chain.
4. Venv resolvers ready for direct launch: runtimeBootstrapCore.ts:2461-2471 (Scripts\python.exe / Scripts\hermes.exe).
5. cloud_turn_holder_only seam: the localModelBlocked branch (RBC:4437-4448 + 4734-4739) already finishes cloud-only `ready` skipping ollama/model — gate the Phase-A profile onto it.
6. Platform-neutral env/config writers: prepareCommandEveRuntimeProcessEnv (RBC:1581-1635, HERMES_HOME + nonce path) and config.yaml/SOUL.md writers (RBC:3808-3832).
7. fetch-bundled-python.mjs pin+fail-closed-SHA skeleton (49-152) — extend with x86_64-pc-windows-msvc triple + layout branch.
8. Spawn-based packaged launchers that work under production fuses: benchmark-startup.ts:294-348; command-eve-auto-update.e2e.ts:229-262; fixtures.ts:108-113 dual-name probe.
9. Receipt/evidence machinery: finalAioncoreArtifactReceipt.js sha256+atomic-JSON writer (145-171, generalize off codesign), scripts/release/release-gate-aggregator.mjs (fail-closed aggregator), verify-no-private-keys.mjs (cross-platform secret scan), afterAllArtifactBuild.js:429-567 sha512/latest.yml writer as the Windows latest.yml receipt template.
10. Release-asset plumbing already Windows-aware: prepare-release-assets.sh:80-115, verify-release-assets.sh:54 (after de-staling names).
11. Entitlement/credits/cloud-chat cores + 27 platform-neutral unit-test files (tests/unit/command-eve/*) with injectable seams (keychain.ts:95 setSafeStorageForTesting; loopback/fetch/clock injection in desktopAuthLoopback) — will run on a Windows runner as-is.
12. E2E anchors: AIONUI_E2E_TEST=1 (ephemeral shim port), COMMAND_EVE_UPDATE_FEED_URL='' (updater opt-out) for packaged Windows suites.

## 5. Minimal safe implementation sequence (Phase A)

Day-0 decisions (blocking, cheap): D1 Hermes dep closure (bundle win32 --find-links set vs. declare+gate PyPI network requirement) — owner CTO; D2 CI execution repo/visibility + branch push + Actions bring-up — owner CEO/Codex; D3 packaged-smoke mode (spawn-based now, instrumented fuse profile deferred to Phase C) — recommend spawn-based.

- A0 (0.5d, NEW step): push integration branch; enable/baseline CI (expect red; failures are baseline findings per Phase 0 routine); run the three de-risk probes on a Windows runner: (i) prepareAioncore win32-x64 + aioncore.exe prepare-managed-resources completes and afterPack verify passes; (ii) better-sqlite3 prebuild resolves for Electron 42.6.1 win32-x64; (iii) CDN reachability. These convert P1-3 from INFERENCE to receipt.
- A1 = WIN-010 (1-1.5d): contracts/gate skeleton as scoped; add the two audit-driven contract notes (NTFS ACL stance for the nonce file; public-repo evidence governance).
- A2 = WIN-020 (1-1.5d): fail-closed release lane; single product-name resolver + grep-gate against residual AionUi; x64-only matrix INCLUDING release-distribute.yml latest-win-arm64 requirement adjustment; fix ZIP upload globs; platform-filter the bundled-python extraResources entry until WIN-040 stages real python (keeps builds truthful in the interim); failure-injection test; unpacked-app better-sqlite3 load assert.
- A3 = WIN-030 Phase-A subset (1d): commandExists → `where` on win32; bundled-python runtime resolver win branch (python/python.exe + non-empty candidates); bootstrap-runner taskkill-tree; keep the full ADR-WIN-002 adapter surface minimal — do not gold-plate in Phase A.
- A4 = WIN-040 (2-3d): extend fetch-bundled-python (triple/SHA/layout); execute D1; cloud_turn_holder_only profile on the localModelBlocked seam; direct Scripts\hermes.exe handoff at index.ts:1785/1859 AND assistantStorageRepair registry-row pinning; bootstrap receipt (versions/hashes/duration/stages); interrupted-bootstrap repair + offline classification tests.
- A5 = WIN-060 (1-1.5d, parallel lane after A2): free/paid-balance/paid-zero/expired matrix on Windows + the four new negative rows from P1-6; bundle secret scan (expect only the public anon key).
- A6 = WIN-070 (1.5-2d): clean-VM lifecycle — spawn-based packaged launch smoke; install/uninstall/residue harness (greenfield — no substrate exists: NSIS /S install, per-user paths, uninstaller, process/file/registry residue scan); one managed cloud chat through shim receipt; evidence bundle via adapted receipt writer + gate aggregator; WIN-G02..G08 + G06T receipts on one artifact hash.

Merge order unchanged from the plan (WIN-010 → 020/030 → 040/060 → 070); the only sequencing correction: a slice of bundled-python handling (the extraResources platform filter) must land WITH WIN-020, not wait for WIN-040, or WIN-020's "normal build emits all required files" gate cannot pass truthfully.

## 6. Negative tests Phase A must include (beyond the contracts' own lists)

1. Failure injection: forced Windows build error → workflow red, no artifact upload, no release step (kills P0-1 regression).
2. Naming grep-gate: any `AionUi` in workflows/scripts/nsh smoke paths → test fails (kills P1-2 regression class).
3. extraResources truth: remove staged python dir → Windows build must FAIL (not silently ship python-less).
4. afterPack tamper: delete node.exe from staged bundled-aioncore → build fails with the exact missing-path message.
5. better-sqlite3: assert prebuild download path taken (log/receipt), and `require` from the unpacked app on the runner.
6. Python archive SHA mismatch → fetch rejects (extends existing fail-closed path to the win triple).
7. Interrupted venv creation (kill mid-pip) → next boot classifies and repairs; no orphan python.exe after the WIN-030 runner fix (expected-fail before it).
8. Offline first boot (PyPI blocked) → hermes stage classified degraded per D1 decision; app usable enough to show the state; no hang.
9. Second boot idempotency → identical bootstrap receipt.
10. 32GB VM with cloud_turn_holder_only → ollama/model stages skipped by profile (not by RAM), receipt says cloud-only ready.
11. No-bash box: entire bootstrap+turn with no bash.exe/Git-Bash on PATH.
12. Turn-holder stop/app-quit → process tree clean in ≤5s (taskkill path), including python descendants.
13. Registry-row truth: after bootstrap, the agent row aioncore execs points at Scripts\hermes.exe, not the shim (P0-3 regression).
14. Paid+offline → stays entitled (signed wire); paid + credits-status 5xx → no BYOK/tier relock for paid-seat; topup-only variant documented; selection-read failure → paid user NOT silently downgraded to Standard (or explicitly surfaced); resolver/keychain failure → LOCAL/401 degradation visible, never a free-tier bill.
15. Expired wire → re-login flow, no loop; keychain-unavailable simulation → fail-closed drop + clean re-login.
16. Nonce/shim: config.yaml points at 127.0.0.1:25811; port occupied → documented behavior; no firewall dialog on loopback (clean-VM observation).
17. Uninstall: zero owned processes, Programs dir removed, %APPDATA% choice explicit, uninstall registry key gone; installer path-with-spaces install/launch.
18. Bundle secret scan: no CEVE wire plaintext at rest, no service_role/provider-key patterns; public anon key allowlisted.
19. Defender real-time on during install/first-boot/venv-pip (bootstrap latency + false-positive observation, receipt-logged).
20. ZIP artifact presence in CI evidence (P1-1d regression).

## 7. Estimate credibility

Committed 5-8 focused engineering days for Phase A: CREDIBLE, medium confidence, under these conditions — two lanes (A5 parallel), Day-0 decisions D1-D3 made up front, A0 de-risk probes green, and the clean-Win11 VM harness available from Day A4 (per plan §13 it exists as a capability). Audit-based accounting: A0 0.5 + A1 1-1.5 + A2 1-1.5 + A3 1 + A4 2-3 + A6 1.5-2 ≈ 7-9.5 sequential, ≈ 5.5-8 with A5 parallel and no compounding surprises. The 4-day stretch is NOT credible: it requires first-pass success on the two never-executed surfaces (fork CI bring-up; aioncore self-assembly with fork pins) plus the greenfield uninstall/residue harness. Solo, expect 7-10. The plan's own correction of the original 1-2-day claim is validated; do not re-shorten it.

## 8. Contradiction resolutions across specialists

- Plan R5 ("descendants may survive", high) vs specialist-2's win-ready supervision: BOTH true at different layers — long-lived pair (aioncore/Hermes/ACP children) already taskkill-tree'd; only the transient bootstrap runner is single-SIGTERM. Phase-A risk is bounded to mid-bootstrap cancellation; ADR-WIN-005 Job-Objects remain a Phase B/C target.
- Specialist-1's "afterPack aioncore gate = highest-risk unknown" vs principal's asset/CDN evidence: resolved — binary-only zip is by design; self-assembly inputs all published+pinned; mechanism upstream-proven today; fork pins need one verification run (A0 probe).
- Specialist-1's "windows smoke can miss the real executable" (plan wording) vs actual behavior: it cannot miss-and-pass; it throws and false-FAILS. The deceptive-green lives only in the release lane (P0-1).
- Specialist-3's hook refinement vs plan's "short-circuit outside Electron ⇒ browser delivery blocked": hooks are mirrors; the real enforcement (REMOTE_WEBUI_DISABLED, shim bearer, server 402/429) is main/server-side — plan's product conclusion (browser is not a shortcut) unchanged and reinforced.
- Specialist-2's "bundled-aioncore win32-x64 not staged in-tree" vs specialist-1's build-time prep: not a contradiction — staging is a build-runner action (prepareAioncore); nothing should be committed in-tree.

## 9. Hermes-free lane (constraint compliance)

Not proposed, per instruction and per ADR-WIN-011. Code audit independently confirms the premise: the EVE fallback order is ['hermes'] (commandEveShell.ts:122), aionrs is deliberately refused (assistantBootstrapCore.ts:1074-1088), zero provider chat hostnames exist in the main process, and the only bearer egress is the loopback shim → edge function (ollamaOpenAiShim.ts:1061). A Node bypass would have to re-create egress-boundary, nonce-auth, metering and receipt semantics — reinforcing the plan's rejection.

## 10. Handback

- state: PASS (review complete; no blocking ambiguity for dispatching WIN-010/WIN-020 after Day-0 decisions D1-D3)
- scope_completed: five specialist areas audited against real code at 5af678cc; 26/26 plan FACTs re-verified; 4 P0, 6 P1, ~10 P2 findings with anchors; reuse inventory; sequence; negative tests; estimate verdict
- files_changed: none (read-only; this plan file only)
- evidence: specialist reports (3), principal probes (git/gh remotes+runs, AionCore v0.1.37 win zip inventory, static.aionui.com manifests for node/codex-acp/claude-agent-acp win targets, better-sqlite3 v12.11.1 prebuild list, upstream v2.1.35 pins), canonical plan + 8 contract files read in full
- residual_risks: fork-pin verification (A0 probe), D1 closure decision, first-CI-bring-up unknowns, DPAPI-in-CI packaged-test contexts
- rollback: none required (no changes made)
- reflection: what_worked — verifying plan FACTs against live bytes/endpoints (zip inventory, CDN manifests) converted the two biggest "unknowns" into dispatchable receipts; what_failed — nothing material; calibration_gap — the plan under-indexed on runtime-side (vs build-side) Python resolution and on the zero-CI-history reality; both now explicit.

FABLE_PHASE_A_PREBUILD_COMPLETE
