#!/usr/bin/env node
/**
 * Fetch the hash-pinned CPython 3.12 arm64 Hermes runtime closure for the
 * build-only cache. Raw wheels never enter the app: the existing Artifact
 * Python stager extracts them into the bundled interpreter and afterSign
 * deep-signs every native file before notarization.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
export const HERMES_RUNTIME_LOCK = path.join(
  REPO_ROOT,
  'resources',
  'bundled-python-artifacts',
  'hermes-runtime-darwin-arm64.tsv'
);
export const HERMES_RUNTIME_CACHE = path.join(
  REPO_ROOT,
  'build',
  'bundled-python',
  'hermes-runtime-wheels',
  'darwin-arm64'
);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_PACKAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function parseHermesRuntimeLock(text) {
  const entries = [];
  const names = new Set();
  for (const [index, rawLine] of String(text || '')
    .split(/\r?\n/)
    .entries()) {
    if (!rawLine) continue;
    const fields = rawLine.split('\t');
    if (fields.length !== 4) throw new Error(`Hermes runtime lock line ${index + 1} must have four TSV fields.`);
    const [name, version, sha256, source] = fields;
    if (!SAFE_PACKAGE_PATTERN.test(name) || !version || !SHA256_PATTERN.test(sha256)) {
      throw new Error(`Hermes runtime lock line ${index + 1} has an invalid identity or SHA-256.`);
    }
    const normalizedName = name.toLowerCase().replace(/[-_.]+/g, '-');
    if (names.has(normalizedName)) throw new Error(`Duplicate Hermes runtime distribution: ${name}`);
    names.add(normalizedName);

    let filename = '';
    if (source.startsWith('repo://')) {
      const relative = source.slice('repo://'.length);
      if (!relative || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').includes('..')) {
        throw new Error(`Hermes runtime lock line ${index + 1} has an unsafe repository source.`);
      }
      filename = path.posix.basename(relative);
    } else {
      const url = new URL(source);
      if (url.protocol !== 'https:' || url.hostname !== 'files.pythonhosted.org' || url.search || url.hash) {
        throw new Error(`Hermes runtime lock line ${index + 1} has an untrusted wheel URL.`);
      }
      filename = path.posix.basename(url.pathname);
    }
    if (!filename.endsWith('.whl') || filename.includes('\\')) {
      throw new Error(`Hermes runtime lock line ${index + 1} has an invalid wheel filename.`);
    }
    entries.push({ name, version, sha256, source, filename });
  }
  if (entries.length !== 78 || !names.has('hermes-agent') || !names.has('ddgs')) {
    throw new Error(
      `Hermes runtime lock must contain the exact 78-distribution acp+mcp+ddgs closure; found ${entries.length}.`
    );
  }
  const sorted = [...entries].sort((left, right) =>
    left.name
      .toLowerCase()
      .replace(/[-_.]+/g, '-')
      .localeCompare(right.name.toLowerCase().replace(/[-_.]+/g, '-'))
  );
  if (JSON.stringify(entries.map((entry) => entry.name)) !== JSON.stringify(sorted.map((entry) => entry.name))) {
    throw new Error('Hermes runtime lock must remain sorted by distribution name.');
  }
  return entries;
}

export function resolveLockedWheelSource(entry, repoRoot = REPO_ROOT, cacheRoot = HERMES_RUNTIME_CACHE) {
  if (entry.source.startsWith('repo://')) {
    const sourcePath = path.resolve(repoRoot, ...entry.source.slice('repo://'.length).split('/'));
    const relative = path.relative(repoRoot, sourcePath);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error(`Repository wheel escaped: ${entry.name}`);
    return { sourcePath, cachePath: '', remote: false };
  }
  return { sourcePath: '', cachePath: path.join(cacheRoot, entry.filename), remote: true };
}

async function downloadExact(entry, targetPath) {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  const response = await fetch(entry.source, { redirect: 'error' });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${entry.name}@${entry.version}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== entry.sha256) throw new Error(`Hermes runtime wheel hash mismatch for ${entry.filename}: ${actual}`);
  fs.writeFileSync(tempPath, bytes, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tempPath, targetPath);
  fs.chmodSync(targetPath, 0o600);
}

export async function fetchBundledHermesRuntime(options = {}) {
  const lockPath = path.resolve(options.lockPath || HERMES_RUNTIME_LOCK);
  const cacheRoot = path.resolve(options.cacheRoot || HERMES_RUNTIME_CACHE);
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
  const entries = parseHermesRuntimeLock(fs.readFileSync(lockPath, 'utf8'));
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });

  for (const entry of entries) {
    const resolved = resolveLockedWheelSource(entry, repoRoot, cacheRoot);
    const wheelPath = resolved.remote ? resolved.cachePath : resolved.sourcePath;
    if (fs.existsSync(wheelPath) && sha256File(wheelPath) === entry.sha256) continue;
    if (!resolved.remote) throw new Error(`Pinned repository wheel is missing or altered: ${entry.source}`);
    if (fs.existsSync(wheelPath)) fs.rmSync(wheelPath, { force: true });
    // Sequential downloads keep the exact failing artifact visible and bound memory.
    // eslint-disable-next-line no-await-in-loop
    await downloadExact(entry, wheelPath);
  }

  const receipt = {
    version: 'command-eve-hermes-runtime-wheel-cache/v1',
    lock_sha256: sha256File(lockPath),
    platform: 'darwin',
    arch: 'arm64',
    package_count: entries.length,
    files: entries.map((entry) => ({
      name: entry.name,
      version: entry.version,
      sha256: entry.sha256,
      source: entry.source,
      filename: entry.filename,
    })),
  };
  fs.writeFileSync(path.join(cacheRoot, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  return receipt;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  fetchBundledHermesRuntime()
    .then((receipt) => {
      console.log(`[fetch-bundled-hermes-runtime] ${receipt.package_count} exact wheels; lock=${receipt.lock_sha256}`);
    })
    .catch((error) => {
      console.error('[fetch-bundled-hermes-runtime] ERROR:', error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
