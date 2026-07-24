# 1.819 Pro-verdict remediation — GPT-5.6-Pro REJECT → gate closure

Date: 2026-07-24. Branch `codex/command-eve-1819-security`, base commit
`3e23246c` plus the working delta documented below. Reviewer inputs:
GPT-5.6-Pro verdict (REJECT, P0–P3 + five mandatory gates) and Kimi K3
security audit (PASS-WITH-CONDITIONS, F-01…F-16, five release conditions).

## Pro verdict — finding-by-finding resolution

### P0-1 Pillow 12.2.0 → 12.3.0

Done pre-verdict-review in the working delta; verified this pass:

- Both platform wheels pinned to `pillow-12.3.0` in
  `resources/bundled-python-artifacts/manifest.json`
  (`darwin-arm64` cp312-macosx_11_0_arm64, `win32-x64` cp312-win_amd64).
- All 16 wheel SHA-256s re-verified byte-exact against the manifest
  (11 common + 2 darwin + 3 win32: ALL-OK).
- `COMMAND_EVE_ARTIFACT_PYTHON_NATIVE_PACKAGES` carries Pillow 12.3.0; the
  import probe asserts `PIL.__version__ == "12.3.0"`.
- Pillow 12.3.0's PEP-770 SBOM is merged into the aggregate SBOM (24 embedded
  native components incl. FreeType, HarfBuzz, libjpeg-turbo, libtiff).

### P1-1 Wheel-to-tree integrity (RECORD)

- Staging verifies every archive member against RECORD (sha256 + size),
  rejects missing/extra/duplicate RECORD entries, NFC/casefold collisions,
  traversal/backslash/ADS paths, symlinks, special files.
- `.data/` schemes `purelib`/`platlib`/`scripts` are spread per wheel spec;
  every other scheme fail-closes (worker-verified, 17/17 mutation tests in
  `scripts/stage-bundled-artifact-python.test.mjs`).
- Post-sign tree allowlist: `scripts/signArtifactPythonReceipt_core.js`
  re-enumerates the artifact tree AFTER deep-signing and rewrites the runtime
  receipt (`tree_phase: 'signed'`, fresh per-file hashes) BEFORE the outer
  .app re-seal in `scripts/afterSign.js`. Fixes the stale-pre-sign-hash class
  (codesign rewrites Mach-O bytes). 4/4 unit tests.

### P1-2 .pth / import provenance

- Bootstrap is `python -I -P -S`; probe asserts `sys.flags.isolated == 1`,
  `safe_path == 1`, `no_user_site == 1`, `ignore_environment == 1`.
- `sys.path` contains only the signed artifact root (explicit insert).
- Every module origin must resolve under the signed artifact root
  (`assert_artifact_origin` for all 13 modules + native `lxml.etree`,
  `lxml.objectify`, `PIL._imaging`).
- Probe runs with sanitized env (all `PYTHON*` stripped) in a dedicated
  0o700 CWD — CWD/PYTHONPATH/user-site/sitecustomize shadowing is
  structurally excluded by the interpreter flags.

### P1-3 XLSX closure (defusedxml)

- `defusedxml==0.7.1` pinned (hash-verified) and in
  `COMMAND_EVE_PRESENTATION_PYTHON_PACKAGES`; probe asserts
  `openpyxl.DEFUSEDXML is True`.
- macOS resolution: 13 distributions; Windows: 14 (incl. colorama).

### P1-4 Native signing evidence

- `deepSignPython_core.js` enumerates every Mach-O by magic/probe (not by
  fixed count), signs each individually inside-out with the Developer ID,
  then re-seals the outer .app. afterPack's packaged-resources verifier
  asserts every native file carries the expected arm64 slice.
- Post-sign receipt rewrite (P1-1) makes the native-file receipt fresh AFTER
  signing — no pre-sign byte hashes are presented as final.
- **Named exception (documented tradeoff):** the bundled CPython interpreter
  keeps `com.apple.security.cs.disable-library-validation` (and the main app
  entitlement set keeps it as before). Rationale: the interpreter must also
  load user-venv native wheels by design; the shipped artifact tree is
  protected by a stronger, application-layer control (hash-pinned tree +
  fail-closed runtime verifier + per-file codesign evidence). Owner:
  Command EVE Security / CTO. Review trigger: 1.820 entitlement-tightening
  evaluation (carry-over). Changing this entitlement last-minute without a
  packaged test cycle is the exact way to break a notarized release.

### P1-5 PDF rendering / scan-PDF closure

- PyMuPDF exclusion stands (AGPL/commercial); pypdf + PDF.js + ReportLab
  cover the baseline. Documented with the corrected pdfplumber rationale
  (second parser/extraction stack, not "second renderer").
- Scan-PDF path: EVE's vision-capable inference (managed multimodal gateway,
  OpenRouter-backed) carries image-based PDF pages; no silent
  local-vision/Ollama fallback is presented to users (the 1.819 managed
  image/document intelligence services in this delta).

### P2-1 Windows colorama

- `colorama==0.4.6` pinned for win32-x64; closure test proves
  `qrcode`'s win32 marker resolves (and fails closed without it).

### P2-2 License/notice closure

- Staging now emits `sbom.cyclonedx.json` (CycloneDX 1.5: 13 wheel components
  with purl/license/wheel-sha256 + 24 embedded native components from PEP-770
  wheel SBOMs) and `THIRD_PARTY_NOTICES.txt` (14 dist-info license payloads,
  full texts) from the FINAL staged tree, both inside the signed tree and
  covered by `tree_root_sha256`. Receipt carries a `compliance` block with
  both file hashes. Missing license payload for any distribution fails the
  staging build.

### P2-3 Provenance lock

- The release build consumes only the checked-in wheels; the staging receipt
  binds wheel SHA-256 + core-metadata SHA-256 + wheel tags per package, and
  `build_manifest_sha256` binds the manifest. The packaged-resources verifier
  re-checks manifest hash ↔ receipt ↔ installed dist-info metadata in the
  final .app. (Full index/upload-serial attestation: carry-over to 1.820.)

### P2-4 PDF font/unicode scope

- Baseline scope: ReportLab built-in Type-1 fonts cover Latin/WinAnsi incl.
  German umlauts and the Euro sign; complex scripts (CJK, Arabic, Indic) and
  emoji are outside the 1.819 baseline and must surface as a defined scope
  limitation, not silent tofu. (Scope enforcement probe: carry-over.)

### P3-1 Manifest-derived distribution count

- Counts derive from the platform-resolved manifest (13 darwin / 14 win32);
  no hardcoded constant 12 remains in tests
  (`presentationPythonRuntime.test.ts` asserts via
  `COMMAND_EVE_ARTIFACT_PYTHON_PACKAGES` / `commandEveArtifactPythonPackages('win32')`).

### P3-2 pdfplumber exclusion wording — corrected (see P1-5).

### P3-3 Image format capability preflight

- Baseline image support = Pillow-tested raster formats; HEIC handled via
  macOS-native path where available; unsupported formats must end in a
  defined capability answer, not a generic import error or an install prompt
  (the 1.819 managed image/document services never route users to Ollama
  downloads).

## Kimi K3 audit — condition-by-condition resolution

1. **F-01 (P1) exception ledger under CI paths-ignore** — fixed in delta:
   `docs/**` removed from `pr-checks.yml` paths-ignore; ledger changes now
   always run the gate.
2. **F-07 C9 first-run bundle gate not wired** — wired as a REQUIRED
   fail-closed gate in the release-gate aggregator
   (`first-run-bundle`, runner spawns `verify-command-eve-first-run-bundle.mjs`;
   `--app` + `--user-data` required; PASS-from-nonzero-exit forced back to
   BLOCKED). Aggregator tests: 15/15.
3. **F-06 Windows key-scan lane** — `verifyNoPrivateKeysShipped` hoisted
   before the darwin early-return in `afterAllArtifactBuild.js` (runs on every
   platform) + explicit `verify-no-private-keys.mjs public resources` step in
   the Windows lane of `_build-reusable.yml`.
4. **F-08 phantom `--production` flag** — removed; gate audits the complete
   lockfile; ledger scope string corrected.
5. **F-16 branch protection** — NOT verifiable from the repo. Founder action:
   confirm the `Code Quality` check (runs `security:audit:production`) is a
   required status check on the release branch in GitHub repo settings.

### Kimi P2/P3 fixes landed this pass

- **F-03** adapter IPC sender now asserts the sender-frame URL against
  `isTrustedMainRendererUrl` (defense in depth).
- **F-04** explicitly supplied `ollamaBaseUrl` must be loopback http; shim
  start fails closed otherwise (+2 tests).
- **F-05** `redirect: 'error'` on all five upstream fetch lanes (+ existing
  cloud lane).
- **F-09** tripwire honestly documented (substring scan, not module-graph
  reachability) in gate source + ledger wording.
- **F-10** private-key scanner second tier: small `.txt`/`.dat` files whose
  FIRST bytes are a PEM header are flagged (renamed-PEM evasion closed; doc
  quotes don't match). 7/7 new tests.
- **F-11** `Sentry.close(0)` on consent revocation — queued envelopes cannot
  flush after opt-out.
- **F-12** OS home-path redaction (`/Users/<name>`, `/home/<name>`,
  `C:\Users\<name>`) added to the Sentry redactor (covers stack-frame
  filename/abs_path); renderer Sentry init fails closed if any
  renderer-reachable DSN is configured (egress stays main-process-only,
  consent-gated).
- **F-14** shim top-level 500 no longer echoes raw `error.message`; only
  `CommandEveShimPublicError` (explicit allowlist class) may surface a
  message; non-OK upstream statuses now record `upstream_error` in the
  outcome receipt instead of silent `completed`. 59/59 shim tests.
- **F-15** `--audit-json`/`--ledger`/`--now` are test-only hooks, gated
  behind `COMMAND_EVE_AUDIT_GATE_TEST_HOOKS=1` (fail closed otherwise).
  11/11 audit-core tests.
- **F-02** verified already fixed in delta: `isCommandEveFounderBuildAllowed`
  = `!isPackaged && env` — packaged builds can never be founder-promoted via
  env var.
- **F-13** (P3, per-provider exact schemas over time) — carry-over to 1.820.

## Gate evidence snapshot

- Staging run: `darwin-arm64: 13 packages, 33 native files, probe=pass`.
- SBOM: 13 components + 24 embedded native components; notices: 14 license
  files; both inside the signed tree; receipt `compliance` block present.
- Staging mutation battery: 17/17 (byte flip, extra/missing RECORD entries,
  wrong hash/size, casefold + NFC/NFD collisions, backslash/ADS traversal,
  `.data` accept/reject matrix, cross-wheel collision).
- Site-verifier mutation battery: 13/13 (extra file, removed file, flipped
  byte, native post-sign modification, symlink, tampered receipt fields,
  stale-receipt rehash attack).
- Post-sign receipt rewrite: 4/4.
- Aggregator incl. first-run-bundle gate: 15/15.
- Release-gate node tests: 50/50.
- Shim suite: 59/59. Audit core: 11/11. Key scanner: 7/7.
- `bun run security:audit:production`: PASS (1 advisory, 1 reviewed
  exception — `@hono/node-server` moderate, not-reachable, owner-bound,
  expires 2026-08-22; no parser/decoder-path exception).
- TypeScript: `tsc --noEmit` clean (0 errors).
- Version bumped to 1.819.0 in package.json, commandEveShell.ts,
  command-eve-brand.json, command-eve-runtime-bootstrap.json,
  command-eve-capabilities.json.

## Carry-overs to 1.820

1. F-13: extend exact-key payload schemas across mutation providers.
2. P2-3 remainder: index/upload-serial acquisition provenance in the wheel
   lock.
3. P2-4 remainder: PDF unicode scope-enforcement probe (defined scope error
   for CJK/Arabic/Indic/emoji).
4. Entitlement tightening evaluation (`disable-library-validation` on the
   bundled interpreter) with a full packaged test cycle.
5. F-16: founder confirms required status check in GitHub repo settings.
