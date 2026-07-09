import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evaluateMacUpdateFeed,
  metadataFileNameForMacArch,
  parseMacUpdateYml,
  sha512Base64,
} from './verify-mac-update-feed-core.mjs';

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-feed-gate-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeArtifacts(dir, version = '1.7.91', arch = 'arm64') {
  const dmg = path.join(dir, `Command-EVE-${version}-mac-${arch}.dmg`);
  const zip = path.join(dir, `Command-EVE-${version}-mac-${arch}.zip`);
  fs.writeFileSync(dmg, `final-${arch}-dmg-bytes`);
  fs.writeFileSync(zip, `final-${arch}-zip-bytes`);
  const metadata = path.join(dir, metadataFileNameForMacArch(arch));
  fs.writeFileSync(
    metadata,
    [
      `version: ${version}`,
      'files:',
      `  - url: ${path.basename(zip)}`,
      `    sha512: ${sha512Base64(zip)}`,
      `    size: ${fs.statSync(zip).size}`,
      `  - url: ${path.basename(dmg)}`,
      `    sha512: ${sha512Base64(dmg)}`,
      `    size: ${fs.statSync(dmg).size}`,
      `path: ${path.basename(zip)}`,
      `sha512: ${sha512Base64(zip)}`,
      "releaseDate: '2026-07-09T12:00:00.000Z'",
      'releaseNotes: |',
      `  Command EVE ${version}`,
      '',
    ].join('\n')
  );
  return { dmg, zip, metadata };
}

test('parses the controlled electron-updater mac yml shape', () => {
  const parsed = parseMacUpdateYml(`version: 1.7.91
files:
  - url: Command-EVE-1.7.91-mac-arm64.zip
    sha512: ziphash
    size: 11
  - url: Command-EVE-1.7.91-mac-arm64.dmg
    sha512: dmghash
    size: 22
path: Command-EVE-1.7.91-mac-arm64.zip
sha512: ziphash
`);
  assert.equal(parsed.version, '1.7.91');
  assert.equal(parsed.path, 'Command-EVE-1.7.91-mac-arm64.zip');
  assert.equal(parsed.sha512, 'ziphash');
  assert.deepEqual(parsed.files.map((file) => file.url), [
    'Command-EVE-1.7.91-mac-arm64.zip',
    'Command-EVE-1.7.91-mac-arm64.dmg',
  ]);
});

test('passes when arm64 metadata matches final DMG and ZIP bytes', () =>
  withTempDir((dir) => {
    const { dmg } = writeArtifacts(dir);
    const result = evaluateMacUpdateFeed({ dmgPath: dmg, outDir: dir });
    assert.equal(result.status, 'PASS');
  }));

test('blocks stale generic mac metadata in an arm64-only release', () =>
  withTempDir((dir) => {
    const { dmg } = writeArtifacts(dir);
    fs.writeFileSync(path.join(dir, 'latest-mac.yml'), 'version: 1.7.91\nsha512: stale-pre-staple\n');
    const result = evaluateMacUpdateFeed({ dmgPath: dmg, outDir: dir });
    assert.equal(result.status, 'BLOCKED_STALE_METADATA');
  }));

test('blocks yml hash mismatch against final artifact bytes', () =>
  withTempDir((dir) => {
    const { dmg, metadata } = writeArtifacts(dir);
    fs.writeFileSync(metadata, fs.readFileSync(metadata, 'utf8').replace(sha512Base64(dmg), 'pre-staple-dmg-hash'));
    const result = evaluateMacUpdateFeed({ dmgPath: dmg, outDir: dir });
    assert.equal(result.status, 'BLOCKED_HASH_MISMATCH');
  }));

test('blocks missing mac zip because electron-updater needs the zip path', () =>
  withTempDir((dir) => {
    const { dmg, zip } = writeArtifacts(dir);
    fs.rmSync(zip, { force: true });
    const result = evaluateMacUpdateFeed({ dmgPath: dmg, outDir: dir });
    assert.equal(result.status, 'BLOCKED_ARTIFACT_MISSING');
  }));
