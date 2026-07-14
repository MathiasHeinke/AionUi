#!/usr/bin/env node
/**
 * fetch-bundled-python.mjs — Bundled Python S1 (build-time fetch + verify + stage).
 *
 * Downloads a PINNED astral-sh/python-build-standalone `install_only` tarball for
 * CPython 3.12.x, SHA256-verifies it against the release's published checksum
 * (FAIL-CLOSED on mismatch — never extract an unverified binary), and extracts it
 * into the build staging dir so the layout is:
 *
 *   macOS:  build/bundled-python/python/bin/python3.12
 *   Windows: build/bundled-python/python/python.exe
 *
 * electron-builder then maps `build/bundled-python/python` -> `python` via
 * `extraResources`, landing it at `Contents/Resources/python/` in the packaged app.
 * (S2 bootstrap reads `Resources/python/bin/python3.12`; S3 must deep-sign
 * `Resources/python/**` before notarize. See docs/bundled-python.md.)
 *
 * Idempotent: if the already-staged tarball verifies against the pinned SHA256,
 * the download is skipped (re-extracts only if the python dir is missing).
 *
 * Do NOT commit the downloaded/extracted binary to git (~25 MB compressed, see
 * .gitignore: build/bundled-python/). Fetch at build/CI time, cache locally.
 *
 * Usage:
 *   node scripts/fetch-bundled-python.mjs # default arm64 macOS
 *   node scripts/fetch-bundled-python.mjs --platform win32 --arch x64
 *   BUNDLED_PYTHON_PLATFORM=win32 BUNDLED_PYTHON_ARCH=x64 node scripts/fetch-bundled-python.mjs
 *
 * The pure logic (URL/arch construction + sha-verify decision) is exported for
 * unit testing; side effects (network/fs) run only when invoked directly.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// PINNED RELEASE — astral-sh/python-build-standalone
// ---------------------------------------------------------------------------
// Release tag + CPython version + the canonical SHA256 from that release's
// published `SHA256SUMS` (https://github.com/astral-sh/python-build-standalone/
// releases/download/<TAG>/SHA256SUMS). Verified end-to-end on 2026-06-16: the
// real tarball hashes to the arm64 value below and extracts to python/bin/python3.12
// running CPython 3.12.13 with venv+ssl+ctypes support.
//
// To bump: pick a new release tag, download its SHA256SUMS, and copy the line
// for `cpython-<PY_VERSION>+<TAG>-<arch>-apple-darwin-install_only.tar.gz`.
export const RELEASE_TAG = '20260610';
export const PY_VERSION = '3.12.13';
export const CHECKSUM_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE_TAG}/SHA256SUMS`;

// Map our arch token -> python-build-standalone target triple.
export const ARCH_TRIPLES = Object.freeze({
  arm64: 'aarch64-apple-darwin',
  aarch64: 'aarch64-apple-darwin',
  x86_64: 'x86_64-apple-darwin',
  x64: 'x86_64-apple-darwin',
});

export const WINDOWS_ARCH_TRIPLES = Object.freeze({
  x86_64: 'x86_64-pc-windows-msvc',
  x64: 'x86_64-pc-windows-msvc',
});

// Published SHA256 per arch token. FAIL-CLOSED: an arch without a verified,
// non-TODO sha here cannot be fetched.
//
// arm64 — VERIFIED 2026-06-16 against the release SHA256SUMS + a real download.
// x86_64 — NOT YET PINNED. The Intel `install_only` tarball exists in release
//   20260610, but we ship arm64-only for now (Alois + most pilots are Apple
//   Silicon — see docs/specs/command-eve-bundled-python-design.md). Before
//   enabling x64, fill the real sha from CHECKSUM_URL for
//   `cpython-3.12.13+20260610-x86_64-apple-darwin-install_only.tar.gz`.
export const SHA256_BY_ARCH = Object.freeze({
  arm64: 'e18ddd4c1e8f4a1d6c4590b37f423d76aec734447edc20ed08e93983d95f2132',
  aarch64: 'e18ddd4c1e8f4a1d6c4590b37f423d76aec734447edc20ed08e93983d95f2132',
  // TODO(x64): fill the real SHA256 from CHECKSUM_URL before enabling x86_64.
  // Until then the script fails-closed (treated as unpinned). Canonical source:
  //   https://github.com/astral-sh/python-build-standalone/releases/download/20260610/SHA256SUMS
  x86_64: null,
  x64: null,
});

// Verified 2026-07-14 against the release's SHA256SUMS and a real download.
export const WINDOWS_SHA256_BY_ARCH = Object.freeze({
  x86_64: 'f5e4d9f856567493776f3d1e832c939fbaba5dcbcc5e0492a82ecfceea83b316',
  x64: 'f5e4d9f856567493776f3d1e832c939fbaba5dcbcc5e0492a82ecfceea83b316',
});

export const BUNDLED_PYTHON_MANIFEST_FILE = 'command-eve-python-manifest.json';

// Sentinel marking an unpinned (TODO) checksum — fail-closed until replaced.
export const TODO_SHA = null;

// ---------------------------------------------------------------------------
// PURE LOGIC (exported for unit tests; no network/fs side effects)
// ---------------------------------------------------------------------------

/** Normalize an arch token to a python-build-standalone triple. Throws on unknown. */
export function resolveTriple(arch, platform = 'darwin') {
  const triples = platform === 'win32' ? WINDOWS_ARCH_TRIPLES : platform === 'darwin' ? ARCH_TRIPLES : null;
  const triple = triples?.[arch];
  if (!triple) {
    throw new Error(`Unsupported arch "${arch}" for bundled-Python platform=${platform} arch=${arch}.`);
  }
  return triple;
}

/** The install_only tarball filename for an arch. */
export function buildAssetName(arch, { version = PY_VERSION, tag = RELEASE_TAG, platform = 'darwin' } = {}) {
  const triple = resolveTriple(arch, platform);
  return `cpython-${version}+${tag}-${triple}-install_only.tar.gz`;
}

/** The GitHub release download URL for the tarball. */
export function buildDownloadUrl(arch, opts = {}) {
  const tag = opts.tag ?? RELEASE_TAG;
  return `https://github.com/astral-sh/python-build-standalone/releases/download/${tag}/${buildAssetName(arch, opts)}`;
}

/** The pinned, expected SHA256 for an arch, or null if unpinned (TODO). */
export function expectedSha256(arch, platform = 'darwin') {
  // Normalize via the triple map so unknown arches throw consistently.
  resolveTriple(arch, platform);
  const sha = platform === 'win32' ? WINDOWS_SHA256_BY_ARCH[arch] : SHA256_BY_ARCH[arch];
  return sha ?? TODO_SHA;
}

/** True iff this arch has a real (non-TODO) pinned checksum. */
export function isArchPinned(arch, platform = 'darwin') {
  const sha = expectedSha256(arch, platform);
  return typeof sha === 'string' && /^[0-9a-f]{64}$/i.test(sha);
}

/**
 * The fail-closed verify decision. Pure: given the expected sha and the actual
 * computed sha, decide whether extraction may proceed.
 *
 * Returns { ok, reason }. `ok: true` ONLY when a real expected sha is pinned AND
 * the actual sha matches it (case-insensitive). Anything else (missing/TODO
 * expected sha, missing actual sha, or mismatch) is `ok: false` — never extract.
 */
export function decideVerify({ expected, actual }) {
  if (!expected || !/^[0-9a-f]{64}$/i.test(expected)) {
    return {
      ok: false,
      reason: `no pinned SHA256 (unpinned/TODO) — fail-closed. Fill the checksum from ${CHECKSUM_URL}`,
    };
  }
  if (!actual || !/^[0-9a-f]{64}$/i.test(actual)) {
    return { ok: false, reason: 'missing or malformed actual SHA256 of the downloaded file' };
  }
  if (expected.toLowerCase() !== actual.toLowerCase()) {
    return {
      ok: false,
      reason: `SHA256 mismatch — expected ${expected.toLowerCase()}, got ${actual.toLowerCase()}`,
    };
  }
  return { ok: true, reason: 'sha256 verified' };
}

/** Compute the SHA256 hex digest of a buffer (pure helper). */
export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function buildBundledPythonManifest({ platform, arch, triple, assetName, url, archiveSha256 }) {
  return {
    schema_version: 'command-eve-bundled-python/v1',
    platform,
    arch,
    triple,
    python_version: PY_VERSION,
    release_tag: RELEASE_TAG,
    archive_name: assetName,
    archive_sha256: archiveSha256,
    source_url: url,
  };
}

// ---------------------------------------------------------------------------
// CLI / side-effecting runner
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const STAGE_DIR = path.join(REPO_ROOT, 'build', 'bundled-python');

function parseArgs(argv) {
  let arch = process.env.BUNDLED_PYTHON_ARCH || 'arm64';
  let platform = process.env.BUNDLED_PYTHON_PLATFORM || 'darwin';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--arch') arch = argv[++i] || arch;
    else if (argv[i] === '--platform') platform = argv[++i] || platform;
  }
  return { arch, platform };
}

function log(...args) {
  console.log('[fetch-bundled-python]', ...args);
}

async function downloadToFile(url, destPath) {
  log('downloading', url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return buf;
}

function extractTarball(tarballPath, intoDir) {
  // The install_only tarball extracts a top-level `python/` dir into intoDir,
  // yielding intoDir/python/bin/python3.12.
  const result = spawnSync('tar', ['-xzf', tarballPath, '-C', intoDir], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) {
    throw new Error(`tar extraction failed (exit ${result.status}) for ${tarballPath}`);
  }
}

async function main() {
  const { arch, platform } = parseArgs(process.argv.slice(2));
  const triple = resolveTriple(arch, platform);
  const assetOptions = { platform };
  const assetName = buildAssetName(arch, assetOptions);
  const url = buildDownloadUrl(arch, assetOptions);
  const expected = expectedSha256(arch, platform);

  log(`platform=${platform} arch=${arch} triple=${triple} version=${PY_VERSION} tag=${RELEASE_TAG}`);

  if (!isArchPinned(arch, platform)) {
    console.error(
      `[fetch-bundled-python] FAIL-CLOSED: no pinned SHA256 for platform=${platform} arch=${arch}.\n` +
        `  Fill the checksum for ${assetName} from:\n  ${CHECKSUM_URL}`
    );
    process.exitCode = 2;
    return;
  }

  fs.mkdirSync(STAGE_DIR, { recursive: true });
  const tarballPath = path.join(STAGE_DIR, assetName);
  const pythonDir = path.join(STAGE_DIR, 'python');
  const interpreter =
    platform === 'win32' ? path.join(pythonDir, 'python.exe') : path.join(pythonDir, 'bin', 'python3.12');

  // Idempotency: if the staged tarball already verifies, skip the download.
  let buf = null;
  if (fs.existsSync(tarballPath)) {
    const actual = sha256Hex(fs.readFileSync(tarballPath));
    if (decideVerify({ expected, actual }).ok) {
      log('staged tarball already verified — skipping download');
    } else {
      log('staged tarball failed verify — re-downloading');
      fs.rmSync(tarballPath, { force: true });
    }
  }

  if (!fs.existsSync(tarballPath)) {
    buf = await downloadToFile(url, tarballPath);
  } else {
    buf = fs.readFileSync(tarballPath);
  }

  // FAIL-CLOSED verify before any extraction.
  const actual = sha256Hex(buf);
  const decision = decideVerify({ expected, actual });
  if (!decision.ok) {
    fs.rmSync(tarballPath, { force: true });
    console.error(`[fetch-bundled-python] VERIFY FAILED — ${decision.reason}. Aborting.`);
    process.exitCode = 3;
    return;
  }
  log('sha256 verified:', actual);

  // Idempotency: skip extraction if the interpreter is already present.
  if (fs.existsSync(interpreter)) {
    log('interpreter already extracted at', path.relative(REPO_ROOT, interpreter));
  } else {
    fs.rmSync(pythonDir, { recursive: true, force: true });
    extractTarball(tarballPath, STAGE_DIR);
    if (!fs.existsSync(interpreter)) {
      throw new Error(`extraction did not produce ${interpreter}`);
    }
    log('extracted to', path.relative(REPO_ROOT, pythonDir));
  }

  const manifestPath = path.join(pythonDir, BUNDLED_PYTHON_MANIFEST_FILE);
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      buildBundledPythonManifest({ platform, arch, triple, assetName, url, archiveSha256: actual }),
      null,
      2
    )}\n`,
    'utf8'
  );
  log('provenance manifest:', path.relative(REPO_ROOT, manifestPath));

  log('done. interpreter:', path.relative(REPO_ROOT, interpreter));
}

// Run only when invoked directly (so tests can import the pure logic).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error('[fetch-bundled-python] ERROR:', error?.message || error);
    process.exitCode = 1;
  });
}
