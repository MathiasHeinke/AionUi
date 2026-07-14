# Bundled Python (durable runtime fix) — S1: fetch + stage

The app ships a self-contained CPython 3.12 so the runtime never depends on the
user's system Python (the Alois bug: macOS system `python3` was 3.9.6, outside
Hermes' `>=3.11,<3.14` range). Phase A adds the same invariant to Windows x64.
Full design:
`docs/specs/command-eve-bundled-python-design.md` (in the Company.OS repo).

This note covers **S1** — the build-time fetch — and what S2/S3 depend on.

## What S1 does

`scripts/fetch-bundled-python.mjs` (Node, build-time only):

1. For the explicit target platform and arch (default `darwin/arm64`; Phase A
   Windows `win32/x64`), builds the download URL for the
   **pinned** `astral-sh/python-build-standalone` `install_only` tarball.
2. Downloads it and **SHA256-verifies fail-closed** against the release's
   published checksum (`SHA256SUMS`). An unverified or unpinned (TODO) binary is
   **never extracted** — the script exits non-zero.
3. Extracts into `build/bundled-python/`, producing:

   ```text
   build/bundled-python/
     cpython-3.12.13+20260610-<target>-install_only.tar.gz  (cached, gitignored)
     python/
       bin/python3.12        <- macOS interpreter
       python.exe            <- Windows x64 interpreter
       command-eve-python-manifest.json <- verified archive provenance
   ```

Idempotent: a staged tarball that re-verifies skips the download; an existing
target interpreter (`python/bin/python3.12` or `python/python.exe`) skips extraction.
The fetch still rewrites the deterministic provenance manifest so a stale or
missing receipt cannot survive an otherwise valid cached build.

The tarball **and** the extracted tree are gitignored (`build/bundled-python/`;
the Windows tree is about 150 MB unpacked). Fetch at build/CI time; never commit.

### Pin (current)

| field                | value                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------- |
| release tag          | `20260610`                                                                                   |
| CPython              | `3.12.13`                                                                                    |
| macOS arm64          | `aarch64-apple-darwin` — VERIFIED                                                            |
| SHA256 (macOS arm64) | `e18ddd4c1e8f4a1d6c4590b37f423d76aec734447edc20ed08e93983d95f2132`                           |
| Windows x64          | `x86_64-pc-windows-msvc` — VERIFIED                                                          |
| SHA256 (Windows x64) | `f5e4d9f856567493776f3d1e832c939fbaba5dcbcc5e0492a82ecfceea83b316`                           |
| checksum source      | `https://github.com/astral-sh/python-build-standalone/releases/download/20260610/SHA256SUMS` |

macOS x86_64 and Windows ARM64 remain unpinned and fail closed. To bump a pin:
pick a new release tag, read its `SHA256SUMS`, and update the release/version and
platform-specific checksum constants.

Run it standalone:

```bash
node scripts/fetch-bundled-python.mjs            # default arm64
node scripts/fetch-bundled-python.mjs --platform win32 --arch x64
```

Unit tests for the pure logic (URL/arch construction + the fail-closed verify
decision): `node --test scripts/fetch-bundled-python.test.mjs`.

## Packaging — electron-builder (S1)

`packages/desktop/electron-builder.yml` `extraResources` maps the staged tree:

```yaml
- from: build/bundled-python/python
  to: python
```

The packaged app therefore gets a `Resources/python/` tree with
`bin/python3.12` on macOS or `python.exe` on Windows plus the archive-provenance
manifest. The fetch script runs
**before** `electron-builder`; mixed-platform `--all` builds fail closed because
one staging directory cannot safely contain two target runtimes.

## S2 bootstrap (implemented)

- `resolvePythonCommand` prefers the packaged interpreter at
  `<resources>/python/bin/python3.12` (macOS) or
  `<resources>/python/python.exe` (Windows).
- Windows creates the venv under `hermes/venv/Scripts`, exposes that directory
  on `PATH`, and binds AionCore directly to `Scripts/hermes.exe`; no Bash shim,
  system Python, Git, or Bash is required at runtime.
- The Phase A Windows profile is `cloud_turn_holder_only`: Hermes and managed
  cloud chat run, while Ollama/local-model stages are explicit receipt skips.
- The runtime receipt records the Python archive provenance, Hermes wheel hash,
  explicit PyPI first-boot dependency requirement and resolved package snapshot.

## S3 — notarization deep-sign (IMPLEMENTED, file-only)

A bundled CPython is dozens of Mach-O files (`bin/python3.12`, the
`libpython3.12.dylib`, `lib/python3.12/lib-dynload/*.so`,
`libssl`/`libcrypto`/`libffi`, …). Apple notarization REJECTS any embedded
binary that is not Developer-ID-signed + hardened-runtime. electron-builder
signs the `.app` (incl. its own `.node` native modules) but does **not**
hardened-runtime-sign the bundled python tree, so notarization fails on it.

S3 adds a guarded, darwin-only deep-sign step. Pure logic lives in
`scripts/deepSignPython_core.js` (enumerate Mach-O + inside-out ordering +
`codesign` arg construction + entitlements selection), unit-tested by
`scripts/deepSignPython_core.test.mjs` (`node --test`). The hook glue is
`deepSignBundledPython()` in `scripts/afterSign.js`.

**Where in the hook sequence (and why `afterSign`, not `afterAllArtifactBuild`):**
electron-builder runs `afterPack` → (signs the `.app` internally) → **`afterSign`**
→ builds DMG/zip → `afterAllArtifactBuild`. Our `afterSign` already notarizes the
`.app` itself via `@electron/notarize` (it ships as a `zip` target too), and
`afterAllArtifactBuild` rebuilds the DMG **from that same signed `.app`** via
`hdiutil` (COMPA-591). So the deep-sign MUST happen in `afterSign`, **after**
electron-builder's app-sign is verified and **before** `notarize()` — otherwise
the `.app`/`.zip` would be notarized with an un-deep-signed python. Doing it here
also covers the DMG transitively (it is built from the re-sealed `.app`), so the
CAO-passed COMPA-591 notarize/hdiutil flow in `afterAllArtifactBuild` is left
untouched.

**The deep-sign algorithm (inside-out):**

1. Resolve `<App>.app/Contents/Resources/python`. If absent → skip gracefully
   (non-bundle builds keep working). If no signing identity in env → skip with a
   log line.
2. Enumerate every Mach-O: `.so`/`.dylib` by extension, executables under `bin/`,
   plus a `codesign -d` probe fallback for extensionless framework binaries.
   Symlinks are skipped (sign the real target only).
3. Sign **inside-out**: deepest leaves first (`lib-dynload/*.so`, nested
   `.dylib`), then the `bin/python3.12` interpreter **last**, then re-seal the
   outer `.app`. Each leaf:
   `codesign --force --options runtime --timestamp --sign <identity>`. The
   interpreter additionally gets `--entitlements python-entitlements.plist`.
4. Re-seal the `.app` (`--force --options runtime --timestamp --entitlements
entitlements.plist`, **no `--deep`** so the python entitlements survive), then
   `codesign --verify` it before notarize.

The identity is read from env by NAME (`APPLE_DEVELOPER_IDENTITY` / `CSC_NAME` /
`APPLE_DMG_SIGN_IDENTITY` — "Developer ID Application: FYN Labs LLC
(NHNQ7Q5H28)"); it is never embedded.

**`python-entitlements.plist`** (repo root, next to the app `entitlements.plist`)
grants the interpreter `com.apple.security.cs.allow-jit`,
`com.apple.security.cs.allow-unsigned-executable-memory`, and
`com.apple.security.cs.disable-library-validation` so the signed interpreter may
JIT and `dlopen` the signed `.so` extension modules under the hardened runtime.

- **S4 (Founder/HG):** the credentialed notarize **proof-run** of the
  bundled-Python DMG is the gating validation — only the Founder's Apple creds
  can confirm Apple accepts the deep-signed bundle. S3 is file-only; no real
  signing/notarization happens without those creds.
