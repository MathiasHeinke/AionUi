import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  HERMES_RUNTIME_LOCK,
  parseHermesRuntimeLock,
  resolveLockedWheelSource,
  sha256File,
} from './fetch-bundled-hermes-runtime.mjs';

test('the macOS Hermes runtime lock is sorted, complete and hash-pins local source wheels', () => {
  const entries = parseHermesRuntimeLock(fs.readFileSync(HERMES_RUNTIME_LOCK, 'utf8'));
  assert.equal(entries.length, 78);
  assert.equal(entries[0].name, 'agent-client-protocol');
  assert.equal(entries.at(-1).name, 'websockets');
  assert.equal(
    entries.some((entry) => entry.name === 'ddgs' && entry.version === '9.14.4'),
    true
  );
  for (const entry of entries.filter((candidate) => candidate.source.startsWith('repo://'))) {
    const resolved = resolveLockedWheelSource(entry);
    assert.equal(resolved.remote, false);
    assert.equal(path.extname(resolved.sourcePath), '.whl');
    assert.equal(sha256File(resolved.sourcePath), entry.sha256);
  }
});

test('the lock parser rejects a foreign URL and a duplicate distribution before any download', () => {
  const valid = fs.readFileSync(HERMES_RUNTIME_LOCK, 'utf8').trimEnd().split('\n');
  const foreign = [...valid];
  foreign[0] = foreign[0].replace('https://files.pythonhosted.org/', 'https://example.invalid/');
  assert.throws(() => parseHermesRuntimeLock(`${foreign.join('\n')}\n`), /untrusted wheel URL/);

  const duplicate = [...valid, valid[0]].sort().join('\n');
  assert.throws(() => parseHermesRuntimeLock(`${duplicate}\n`), /Duplicate Hermes runtime distribution/);
});

test('the builder fetches before staging and never copies the raw wheel cache into Electron resources', () => {
  const builder = fs.readFileSync(path.resolve('scripts/build-with-builder.js'), 'utf8');
  const fetchCall = builder.indexOf("fetchBundledHermesRuntime('darwin', 'arm64')");
  const stageCall = builder.indexOf("stageBundledArtifactPython('darwin', 'arm64')");
  assert.ok(fetchCall > -1);
  assert.ok(stageCall > fetchCall);

  const electronBuilder = fs.readFileSync(path.resolve('packages/desktop/electron-builder.yml'), 'utf8');
  assert.equal(electronBuilder.includes('hermes-runtime-wheels'), false);
  assert.ok(electronBuilder.includes('build/bundled-python/python'));
});
