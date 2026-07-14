import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARCH_TRIPLES,
  BUNDLED_PYTHON_MANIFEST_FILE,
  PY_VERSION,
  RELEASE_TAG,
  buildAssetName,
  buildBundledPythonManifest,
  buildDownloadUrl,
  decideVerify,
  expectedSha256,
  isArchPinned,
  resolveTriple,
  sha256Hex,
} from './fetch-bundled-python.mjs';

// --- arch / triple resolution ---------------------------------------------

test('resolveTriple maps arm64 + aliases to aarch64-apple-darwin', () => {
  assert.equal(resolveTriple('arm64'), 'aarch64-apple-darwin');
  assert.equal(resolveTriple('aarch64'), 'aarch64-apple-darwin');
});

test('resolveTriple maps x86_64 + x64 to x86_64-apple-darwin', () => {
  assert.equal(resolveTriple('x86_64'), 'x86_64-apple-darwin');
  assert.equal(resolveTriple('x64'), 'x86_64-apple-darwin');
});

test('resolveTriple throws on an unknown arch', () => {
  assert.throws(() => resolveTriple('riscv'), /Unsupported arch/);
});

test('resolveTriple maps the Phase A Windows x64 target explicitly', () => {
  assert.equal(resolveTriple('x64', 'win32'), 'x86_64-pc-windows-msvc');
  assert.throws(() => resolveTriple('arm64', 'win32'), /platform=win32 arch=arm64/);
});

// --- asset name / URL construction ----------------------------------------

test('buildAssetName builds the pinned install_only tarball name (arm64)', () => {
  assert.equal(
    buildAssetName('arm64'),
    `cpython-${PY_VERSION}+${RELEASE_TAG}-aarch64-apple-darwin-install_only.tar.gz`
  );
});

test('buildAssetName builds the x86_64 tarball name', () => {
  assert.equal(
    buildAssetName('x86_64'),
    `cpython-${PY_VERSION}+${RELEASE_TAG}-x86_64-apple-darwin-install_only.tar.gz`
  );
});

test('buildDownloadUrl points at the pinned GitHub release download', () => {
  const url = buildDownloadUrl('arm64');
  assert.equal(
    url,
    `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE_TAG}/cpython-${PY_VERSION}+${RELEASE_TAG}-aarch64-apple-darwin-install_only.tar.gz`
  );
});

test('buildAssetName/url select the pinned Windows install_only archive', () => {
  const options = { platform: 'win32' };
  const name = `cpython-${PY_VERSION}+${RELEASE_TAG}-x86_64-pc-windows-msvc-install_only.tar.gz`;
  assert.equal(buildAssetName('x64', options), name);
  assert.equal(
    buildDownloadUrl('x64', options),
    `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE_TAG}/${name}`
  );
});

test('buildAssetName/url honor version+tag overrides (for future bumps)', () => {
  assert.equal(
    buildAssetName('arm64', { version: '3.12.99', tag: '29990101' }),
    'cpython-3.12.99+29990101-aarch64-apple-darwin-install_only.tar.gz'
  );
  assert.match(
    buildDownloadUrl('arm64', { version: '3.12.99', tag: '29990101' }),
    /29990101\/cpython-3\.12\.99\+29990101-aarch64-apple-darwin-install_only\.tar\.gz$/
  );
});

// --- pin state -------------------------------------------------------------

test('arm64 is pinned with a 64-hex-char sha; x86_64 is unpinned (TODO)', () => {
  assert.equal(isArchPinned('arm64'), true);
  assert.match(expectedSha256('arm64'), /^[0-9a-f]{64}$/);
  assert.equal(isArchPinned('x86_64'), false);
  assert.equal(expectedSha256('x86_64'), null);
});

test('Windows x64 is pinned while Windows ARM64 fails closed', () => {
  assert.equal(isArchPinned('x64', 'win32'), true);
  assert.equal(expectedSha256('x64', 'win32'), 'f5e4d9f856567493776f3d1e832c939fbaba5dcbcc5e0492a82ecfceea83b316');
  assert.throws(() => expectedSha256('arm64', 'win32'), /platform=win32 arch=arm64/);
});

test('every known triple alias resolves (sanity over ARCH_TRIPLES)', () => {
  for (const arch of Object.keys(ARCH_TRIPLES)) {
    assert.ok(resolveTriple(arch).endsWith('-apple-darwin'));
  }
});

// --- fail-closed verify decision (the security keystone) -------------------

test('decideVerify OK only when a pinned expected sha matches the actual', () => {
  const sha = expectedSha256('arm64');
  const decision = decideVerify({ expected: sha, actual: sha });
  assert.equal(decision.ok, true);
});

test('decideVerify is case-insensitive on matching shas', () => {
  const sha = 'a'.repeat(64);
  assert.equal(decideVerify({ expected: sha, actual: sha.toUpperCase() }).ok, true);
});

test('decideVerify FAILS CLOSED on a sha mismatch (never extract)', () => {
  const decision = decideVerify({ expected: 'a'.repeat(64), actual: 'b'.repeat(64) });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /mismatch/);
});

test('decideVerify FAILS CLOSED when the expected sha is unpinned (null/TODO)', () => {
  assert.equal(decideVerify({ expected: null, actual: 'a'.repeat(64) }).ok, false);
  assert.equal(decideVerify({ expected: undefined, actual: 'a'.repeat(64) }).ok, false);
  assert.equal(decideVerify({ expected: '', actual: 'a'.repeat(64) }).ok, false);
});

test('decideVerify FAILS CLOSED on a malformed expected sha (not 64 hex)', () => {
  assert.equal(decideVerify({ expected: 'deadbeef', actual: 'a'.repeat(64) }).ok, false);
  assert.equal(decideVerify({ expected: 'z'.repeat(64), actual: 'a'.repeat(64) }).ok, false);
});

test('decideVerify FAILS CLOSED when the actual sha is missing/malformed', () => {
  const expected = 'a'.repeat(64);
  assert.equal(decideVerify({ expected, actual: null }).ok, false);
  assert.equal(decideVerify({ expected, actual: '' }).ok, false);
  assert.equal(decideVerify({ expected, actual: 'short' }).ok, false);
});

// --- sha256 helper ---------------------------------------------------------

test('sha256Hex matches a known vector (empty input)', () => {
  // SHA256 of the empty string.
  assert.equal(sha256Hex(Buffer.alloc(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256Hex of a known buffer round-trips through decideVerify', () => {
  const buf = Buffer.from('command-eve bundled python', 'utf8');
  const actual = sha256Hex(buf);
  assert.match(actual, /^[0-9a-f]{64}$/);
  assert.equal(decideVerify({ expected: actual, actual }).ok, true);
});

test('buildBundledPythonManifest records immutable Windows archive provenance', () => {
  const archiveSha256 = expectedSha256('x64', 'win32');
  const assetName = buildAssetName('x64', { platform: 'win32' });
  const sourceUrl = buildDownloadUrl('x64', { platform: 'win32' });

  assert.equal(BUNDLED_PYTHON_MANIFEST_FILE, 'command-eve-python-manifest.json');
  assert.deepEqual(
    buildBundledPythonManifest({
      platform: 'win32',
      arch: 'x64',
      triple: resolveTriple('x64', 'win32'),
      assetName,
      url: sourceUrl,
      archiveSha256,
    }),
    {
      schema_version: 'command-eve-bundled-python/v1',
      platform: 'win32',
      arch: 'x64',
      triple: 'x86_64-pc-windows-msvc',
      python_version: PY_VERSION,
      release_tag: RELEASE_TAG,
      archive_name: assetName,
      archive_sha256: archiveSha256,
      source_url: sourceUrl,
    }
  );
});
